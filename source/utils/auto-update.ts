import { join, sep } from "node:path";
import { homedir, platform, arch } from "node:os";
import { readFile, writeFile, rename, chmod, copyFile, unlink, mkdir, readdir, stat, symlink, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createWriteStream } from "node:fs";
import { createHash } from "node:crypto";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import { ensureDir } from "./fs.js";
import { VERSION } from "../version.js";
import { reinstallHint } from "./shell-hints.js";

const AGAV_DIR = join(homedir(), ".agav");
const UPDATE_STATE_FILE = join(AGAV_DIR, "update-state.json");
const CHECK_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const REPO = "prapaa-ai/agav";
/** Prefix for in-flight downloads sitting in ~/.agav, swept on a later launch. */
const DOWNLOAD_PREFIX = "agav-update-";
/** A download older than this cannot belong to a live process worth waiting on. */
const STALE_DOWNLOAD_MS = 24 * 60 * 60 * 1000;

interface UpdateState {
  lastCheck: number;
  latestVersion: string;
  releaseNotes?: string;
  updatedFrom?: string;
  showChangelog?: boolean;
}

function currentVersion(): string {
  return VERSION;
}

/**
 * Pull `major.minor.patch` out of a tag, ignoring any `v` prefix and any
 * pre-release or build suffix. Returns null for anything that isn't a version.
 */
function parseVersion(value: string): [number, number, number] | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(value.trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function isNewer(remote: string, local: string): boolean {
  // Parse rather than `split(".").map(Number)`. A tag like v0.2.0-rc1 turned
  // the last part into NaN, and NaN loses every comparison, so the loop fell
  // through to `return false` — one pre-release marked "latest" would have
  // silently frozen every client on its current version.
  const r = parseVersion(remote);
  const l = parseVersion(local);
  if (!r || !l) return false;
  for (let i = 0; i < 3; i++) {
    if (r[i]! > l[i]!) return true;
    if (r[i]! < l[i]!) return false;
  }
  // Equal core versions: a pre-release of the version we already run is not an
  // upgrade, so don't sidegrade v0.1.7 → v0.1.7-rc1.
  return false;
}

async function loadState(): Promise<UpdateState | null> {
  try {
    const raw = await readFile(UPDATE_STATE_FILE, "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function saveState(state: UpdateState): Promise<void> {
  await ensureDir(AGAV_DIR);
  await writeFile(UPDATE_STATE_FILE, JSON.stringify(state));
}

function getBinaryName(): string {
  const os = platform();
  const cpu = arch();
  // Windows ships x64 only — Bun has no windows-arm64 target, and ARM64
  // Windows runs the x64 build under emulation. It is also the one asset
  // that carries a file extension.
  if (os === "win32") return "agav-windows-x64.exe";
  const osName = os === "darwin" ? "darwin" : "linux";
  const archName = cpu === "arm64" ? "arm64" : "x64";
  return `agav-${osName}-${archName}`;
}

/**
 * Stream one URL to `destPath`, optionally gunzipping it on the way in.
 *
 * Returns false — rather than throwing — for anything that makes this attempt
 * unusable, so the caller can fall back to another URL. The partial file is
 * removed on failure; a truncated ~100 MB download must not be left behind for
 * the stale sweep to find a day later.
 *
 * Returns the SHA-256 hex digest of the bytes written to disk (i.e. after
 * decompression when applicable), or null on failure. Computing the hash
 * inline avoids a second full read of a ~100 MB binary just for checksum
 * verification — the bottleneck that made "Verifying checksum" feel slow.
 */
async function streamAssetToFile(
  url: string,
  destPath: string,
  activity: string,
  decompress: boolean,
): Promise<string | null> {
  // A fixed deadline on the whole transfer would kill a healthy download on a
  // slow link, because the signal stays live while the body streams. Abort on
  // inactivity instead, re-arming the timer each time a chunk arrives.
  const STALL_TIMEOUT_MS = 60_000;
  const controller = new AbortController();
  let stallTimer: ReturnType<typeof setTimeout> | undefined;
  const armStallTimer = (): void => {
    if (stallTimer) clearTimeout(stallTimer);
    stallTimer = setTimeout(() => controller.abort(), STALL_TIMEOUT_MS);
    stallTimer.unref?.();
  };

  try {
    armStallTimer();
    const res = await fetch(url, {
      redirect: "follow",
      signal: controller.signal,
    });
    if (!res.ok || !res.body) return null;

    const totalBytes = Number(res.headers.get("content-length")) || 0;
    let downloadedBytes = 0;
    let lastRender = 0;
    const showProgress = process.stderr.isTTY;
    const renderProgress = (complete = false): void => {
      if (!showProgress) return;

      const now = Date.now();
      if (!complete && now - lastRender < 100) return;
      lastRender = now;

      const downloadedMb = (downloadedBytes / 1024 / 1024).toFixed(1);
      if (totalBytes > 0) {
        const percent = Math.min(100, Math.round((downloadedBytes / totalBytes) * 100));
        const barWidth = 24;
        const filled = Math.round((percent / 100) * barWidth);
        const bar = `${"=".repeat(filled)}${"-".repeat(barWidth - filled)}`;
        const totalMb = (totalBytes / 1024 / 1024).toFixed(1);
        process.stderr.write(`\r  ${activity} [${bar}] ${percent.toString().padStart(3)}% (${downloadedMb}/${totalMb} MB)`);
      } else {
        process.stderr.write(`\r  ${activity} (${downloadedMb} MB)`);
      }
    };

    // Counts bytes off the wire, ahead of any gunzip, so the numbers stay in
    // step with the content-length the server advertised.
    const progressStream = new Transform({
      transform(chunk, _encoding, callback) {
        downloadedBytes += chunk.length;
        armStallTimer();
        renderProgress();
        callback(null, chunk);
      },
    });

    // Hash the decompressed bytes as they stream to disk, so checksum
    // verification doesn't require a second full read of the file.
    const hash = createHash("sha256");
    const hashStream = new Transform({
      transform(chunk, _encoding, callback) {
        hash.update(chunk);
        callback(null, chunk);
      },
    });

    const fileStream = createWriteStream(destPath);
    if (decompress) {
      await pipeline(res.body as any, progressStream, createGunzip(), hashStream, fileStream);
    } else {
      await pipeline(res.body as any, progressStream, hashStream, fileStream);
    }
    renderProgress(true);
    return hash.digest("hex");
  } catch {
    await rm(destPath, { force: true }).catch(() => {});
    return null;
  } finally {
    if (stallTimer) clearTimeout(stallTimer);
  }
}

async function downloadBinary(version: string, label?: string): Promise<string | null> {
  const binaryName = getBinaryName();
  const url = `https://github.com/${REPO}/releases/download/${version}/${binaryName}`;
  // Keyed by pid as well as version: two agav processes updating to the same
  // version at once would otherwise interleave their writes into one file, and
  // both would fail the checksum.
  const tmpPath = join(AGAV_DIR, `${DOWNLOAD_PREFIX}${version}.${process.pid}`);
  const activity = label ?? `Downloading ${version}`;

  try {
    await ensureDir(AGAV_DIR);

    // Releases publish a gzipped copy next to the raw binary; it is roughly a
    // third of the size, which is most of an auto-update's cost on a slow link.
    // Anything at all wrong with it — a release from before the compressed
    // asset existed, a 404, bytes that are not a gzip stream — just falls back
    // to the full binary. Either way the digest below is the one published for
    // the *raw* asset, checked against the decompressed file, so the compressed
    // path is not a second thing to trust.
    //
    // streamAssetToFile returns the SHA-256 of the decompressed bytes written
    // to disk, computed inline during the download. This eliminates the ~100 MB
    // re-read that used to make the post-download checksum step noticeably slow
    // on macOS.
    let fileHash = await streamAssetToFile(`${url}.gz`, tmpPath, activity, true);
    if (!fileHash) fileHash = await streamAssetToFile(url, tmpPath, activity, false);
    if (!fileHash) return null;

    // Verify against the published checksum before this ever becomes
    // executable. We are about to replace our own binary and re-exec it, so an
    // unverified download is a code-execution primitive. Fail closed: if the
    // .sha256 asset is missing or doesn't match, abandon the update.
    if (!(await verifyChecksum(fileHash, `${url}.sha256`))) {
      await rm(tmpPath, { force: true });
      return null;
    }

    await chmod(tmpPath, 0o755);
    return tmpPath;
  } catch {
    await rm(tmpPath, { force: true }).catch(() => {});
    return null;
  }
}

/**
 * Compare a pre-computed hash against the release's published .sha256 asset.
 *
 * Accepts the hex digest directly (computed inline during the download stream)
 * instead of re-reading the file from disk. The previous implementation ran
 * sha256File() on the ~100 MB decompressed binary, which was the main source
 * of the delay users saw after the download progress bar completed.
 */
async function verifyChecksum(actualHex: string, checksumUrl: string): Promise<boolean> {
  try {
    const res = await fetch(checksumUrl, {
      redirect: "follow",
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return false;
    // Format is `<hex>  <filename>` (sha256sum output).
    const expected = (await res.text()).trim().split(/\s+/)[0]?.toLowerCase();
    if (!expected || !/^[a-f0-9]{64}$/.test(expected)) return false;
    return actualHex.toLowerCase() === expected;
  } catch {
    return false;
  }
}

export function getCurrentBinaryPath(): string | null {
  try {
    // Use execPath, NOT argv[0]. Bun sets argv[0] to the literal string "bun"
    // inside a compiled standalone binary, so keying off argv[0] made this
    // return null for every released build — auto-update could never run.
    // execPath is the real executable in a compiled binary, and correctly
    // resolves to the interpreter (bun/node) when run from source, so the
    // guard below still blocks overwriting a system runtime.
    const exec = process.execPath;
    if (!exec) return null;
    const base = exec.split(sep).pop() ?? "";
    // Never overwrite the system Node/Bun binary
    if (/^(node|bun|deno|npx|tsx)/.test(base)) return null;
    // Only update if the binary looks like a Agav binary
    if (!base.startsWith("agav")) return null;
    return exec;
  } catch {
    return null;
  }
}

/**
 * The installer lays binaries out as
 *   <root>/packages/standalone/releases/<version>/agav
 * with `<root>/packages/standalone/current` symlinked at the active release and
 * ~/.local/bin/agav pointing through it.
 *
 * execPath resolves symlinks, so it lands on the *versioned* release file.
 * Overwriting that in place would leave a 0.1.3 binary inside a directory named
 * 0.1.2, which desyncs the installer's bookkeeping (it prunes release dirs that
 * don't match the current target). Detect the layout structurally — not via
 * AGAV_HOME — so a relocated install still works.
 */
export function detectManagedLayout(binaryPath: string): {
  releasesDir: string;
  currentLink: string;
  binaryName: string;
} | null {
  const parts = binaryPath.split(sep);
  const n = parts.length;
  // need at least /standalone/releases/<version>/<binary>
  if (n < 4) return null;
  if (parts[n - 3] !== "releases" || parts[n - 4] !== "standalone") return null;
  const standaloneRoot = parts.slice(0, n - 3).join(sep);
  if (!standaloneRoot) return null;
  return {
    releasesDir: join(standaloneRoot, "releases"),
    currentLink: join(standaloneRoot, "current"),
    binaryName: parts[n - 1] ?? "agav",
  };
}

/** Atomically point `linkPath` at `target` (mirrors install.sh replace_symlink). */
async function replaceSymlink(linkPath: string, target: string): Promise<void> {
  const tmpLink = `${linkPath}.tmp.${process.pid}`;
  await rm(tmpLink, { force: true });
  await symlink(target, tmpLink, process.platform === "win32" ? "junction" : "dir");
  try {
    await rename(tmpLink, linkPath);
  } catch {
    await rm(linkPath, { force: true, recursive: true });
    await rename(tmpLink, linkPath);
  }
}

/**
 * Move a verified download into place. Managed installs get a new versioned
 * release dir plus a symlink swap; a plain binary is replaced in place.
 */
export async function installUpdate(
  downloadedPath: string,
  versionTag: string,
  binaryPath: string,
): Promise<void> {
  const layout = detectManagedLayout(binaryPath);

  if (layout) {
    // Installer names release dirs by bare version (no leading "v").
    const bare = versionTag.replace(/^v/, "");
    const releaseDir = join(layout.releasesDir, bare);
    await mkdir(releaseDir, { recursive: true });
    const dest = join(releaseDir, layout.binaryName);
    await safeMove(downloadedPath, dest);
    await chmod(dest, 0o755);
    await replaceSymlink(layout.currentLink, releaseDir);
    // Only after the symlink points at the new release — a prune that ran first
    // would delete the release we are still running from while `current` still
    // named it, leaving a window where the install is unusable.
    await pruneOldReleases(layout.releasesDir, releaseDir);
    return;
  }

  // Windows will happily rename a running executable but refuses to delete it,
  // and it keeps the lock for as long as this process lives. The backup name is
  // therefore per-process: a leftover from an older still-running agav must not
  // become an undeletable obstacle in the path of the next update's rename.
  const backupPath = `${binaryPath}.${process.pid}.bak`;
  await safeMove(binaryPath, backupPath);
  await safeMove(downloadedPath, binaryPath);
  await chmod(binaryPath, 0o755);
  // Best-effort only. By this point the new binary is already in place, so
  // failing to delete the old one is untidy, not a failed update — reporting it
  // as one sent Windows users chasing an update that had actually succeeded.
  await rm(backupPath, { force: true }).catch(() => {});
}

/**
 * Delete every release directory except the one just installed.
 *
 * install.sh prunes like this at the end of every run; the updater did not, so
 * a managed install grew by one ~100 MB release directory on every single
 * auto-update and never gave the space back.
 *
 * Removing the directory we are currently executing from is safe on POSIX —
 * this branch never runs on Windows — because the kernel keeps the inode alive
 * for the lifetime of the running process.
 */
export async function pruneOldReleases(releasesDir: string, keepDir: string): Promise<void> {
  try {
    const entries = await readdir(releasesDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dir = join(releasesDir, entry.name);
      if (dir === keepDir) continue;
      // Best-effort per directory: one undeletable leftover must not stop the
      // rest from being reclaimed, and none of it can fail the update.
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  } catch {
    // Housekeeping. The update itself already succeeded.
  }
}

/**
 * Delete abandoned downloads from ~/.agav. A process killed mid-transfer leaves
 * a partial ~100 MB file behind, and nothing else ever collects it.
 *
 * Age-gated rather than pid-gated: a live download belonging to a concurrently
 * running agav must not be pulled out from under it, and no legitimate transfer
 * is still in flight a day later.
 */
export async function cleanupStaleDownloads(now = Date.now()): Promise<void> {
  try {
    const entries = await readdir(AGAV_DIR);
    for (const entry of entries) {
      if (!entry.startsWith(DOWNLOAD_PREFIX)) continue;
      const path = join(AGAV_DIR, entry);
      try {
        const info = await stat(path);
        if (!info.isFile() || now - info.mtimeMs < STALE_DOWNLOAD_MS) continue;
        await rm(path, { force: true });
      } catch {
        // Vanished or locked — either way, not this launch's problem.
      }
    }
  } catch {
    // Cleanup is never worth failing a launch over.
  }
}

/**
 * Delete backups left behind by earlier updates. On Windows the process that
 * created one could not delete it while running, so the next launch does it.
 */
export async function cleanupStaleBackups(binaryPath: string): Promise<void> {
  try {
    const parts = binaryPath.split(sep);
    const name = parts.pop() ?? "";
    const dir = parts.join(sep);
    if (!dir || !name) return;
    const stale = (await readdir(dir)).filter(
      (entry) => entry.startsWith(`${name}.`) && entry.endsWith(".bak"),
    );
    for (const entry of stale) {
      await rm(join(dir, entry), { force: true }).catch(() => {});
    }
  } catch {
    // Cleanup is never worth failing a launch over.
  }
}

/** Resolve the path the running process should re-exec after an update. */
function relaunchPath(binaryPath: string): string {
  const layout = detectManagedLayout(binaryPath);
  return layout ? join(layout.currentLink, layout.binaryName) : binaryPath;
}

function extractBullets(body: string): string[] {
  if (!body) return [];
  return body
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^[-*•]/.test(l))
    .map((l) => l.replace(/^[-*•]\s*/, "").trim())
    .filter((l) => l.length > 0 && l.length < 120);
}

export async function getChangelog(): Promise<string> {
  const state = await loadState();
  if (!state?.releaseNotes) {
    return "No changelog available. Update state not found.";
  }
  const bullets = extractBullets(state.releaseNotes);
  const lines: string[] = [];
  lines.push(`Agav ${state.latestVersion}${state.updatedFrom ? ` (updated from v${state.updatedFrom})` : ""}`);
  lines.push("");
  if (bullets.length > 0) {
    for (const b of bullets) {
      lines.push(`  • ${b}`);
    }
  } else {
    lines.push(state.releaseNotes.slice(0, 500));
  }
  return lines.join("\n");
}

async function safeMove(src: string, dst: string): Promise<void> {
  try {
    await rename(src, dst);
  } catch (err: any) {
    if (err?.code === "EXDEV") {
      await copyFile(src, dst);
      await unlink(src);
    } else {
      throw err;
    }
  }
}

export async function forceUpdate(targetVersion?: string): Promise<boolean> {
  const local = currentVersion();
  process.stderr.write(`  Current version: ${local}\n`);

  let latestTag: string;
  let releaseBody = "";

  if (targetVersion) {
    // Pin to specific version
    const tag = targetVersion.startsWith("v") ? targetVersion : `v${targetVersion}`;
    process.stderr.write(`  Fetching version ${tag}...\n`);
    try {
      const res = await fetch(`https://api.github.com/repos/${REPO}/releases/tags/${tag}`, {
        headers: { Accept: "application/vnd.github.v3+json" },
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) {
        process.stderr.write(`  Error: Version ${tag} not found.\n`);
        return false;
      }
      const data = (await res.json()) as { tag_name?: string; body?: string };
      latestTag = data.tag_name ?? tag;
      releaseBody = data.body ?? "";
    } catch {
      process.stderr.write(`  Error: Could not reach GitHub.\n`);
      return false;
    }
  } else {
    // Fetch latest
    process.stderr.write(`  Checking for updates...\n`);
    try {
      const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
        headers: { Accept: "application/vnd.github.v3+json" },
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) {
        process.stderr.write(`  Error: Could not fetch release info (HTTP ${res.status}).\n`);
        return false;
      }
      const data = (await res.json()) as { tag_name?: string; body?: string };
      latestTag = data.tag_name ?? "";
      releaseBody = data.body ?? "";
    } catch {
      process.stderr.write(`  Error: Could not reach GitHub.\n`);
      return false;
    }
  }

  if (!latestTag) {
    process.stderr.write(`  Error: No releases found.\n`);
    return false;
  }

  process.stderr.write(`  Target version: ${latestTag}\n`);

  if (!targetVersion && !isNewer(latestTag, local)) {
    process.stderr.write(`  Already up to date.\n`);
    return true;
  }

  const binaryPath = getCurrentBinaryPath();
  if (!binaryPath) {
    process.stderr.write(`  Cannot auto-update — not running as a standalone binary.\n`);
    process.stderr.write(`  Reinstall with: ${reinstallHint()}\n`);
    return false;
  }

  await cleanupStaleBackups(binaryPath);
  await cleanupStaleDownloads();

  process.stderr.write(`  Downloading ${latestTag}...`);
  const downloaded = await downloadBinary(latestTag);
  if (!downloaded) {
    process.stderr.write(` failed (download or checksum verification failed).\n`);
    return false;
  }

  try {
    await installUpdate(downloaded, latestTag, binaryPath);
    process.stderr.write(` done.\n`);

    const bullets = extractBullets(releaseBody);
    if (bullets.length > 0) {
      process.stderr.write(`\n  What's new:\n`);
      for (const b of bullets.slice(0, 8)) {
        process.stderr.write(`    • ${b}\n`);
      }
    }

    await saveState({
      lastCheck: Date.now(),
      latestVersion: latestTag,
      releaseNotes: releaseBody,
      updatedFrom: local,
    });

    process.stderr.write(`\n  Agav updated: v${local} → ${latestTag}\n`);
    return true;
  } catch (error) {
    // Name the reason. "replace error" alone gave a Windows user reporting a
    // locked-file failure nothing to act on.
    process.stderr.write(` failed (${error instanceof Error ? error.message : String(error)}).\n`);
    // Nothing moved the download into place, so it would otherwise sit in
    // ~/.agav forever — a ~100 MB leak on every failed update.
    await rm(downloaded, { force: true }).catch(() => {});
    return false;
  }
}

export async function checkAndUpdate(): Promise<void> {
  const local = currentVersion();

  // Skip update check in CI, pipe mode, or non-TTY
  if (process.env["CI"] || process.env["AGAV_NO_UPDATE"] === "1" || !process.stdout.isTTY) {
    return;
  }

  // A previous update on Windows could not delete its own backup while it was
  // still running. This launch is the first moment that lock is gone.
  const currentBinary = getCurrentBinaryPath();
  if (currentBinary) await cleanupStaleBackups(currentBinary);
  await cleanupStaleDownloads();

  // Check rate limit
  const state = await loadState();
  if (state && Date.now() - state.lastCheck < CHECK_INTERVAL_MS) {
    return;
  }

  // Check latest version — fail silently on any error
  let latestTag: string;
  let releaseBody = "";
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { Accept: "application/vnd.github.v3+json" },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      await saveState({ lastCheck: Date.now(), latestVersion: local });
      return;
    }
    const data = (await res.json()) as { tag_name?: string; body?: string };
    latestTag = data.tag_name ?? "";
    releaseBody = data.body ?? "";
  } catch {
    // Network unreachable — silently skip, don't cache failure
    return;
  }

  await saveState({ lastCheck: Date.now(), latestVersion: latestTag, releaseNotes: releaseBody });

  if (!latestTag || !isNewer(latestTag, local)) {
    return;
  }

  // New version available — auto-update
  const binaryPath = getCurrentBinaryPath();
  if (!binaryPath) {
    process.stderr.write(`\n  Update available: v${local} → ${latestTag}. Reinstall to update.\n\n`);
    return;
  }

  process.stderr.write(`  Updating Agav ${local} → ${latestTag}...`);

  const downloaded = await downloadBinary(latestTag, `Updating Agav ${local} → ${latestTag}`);
  if (!downloaded) {
    process.stderr.write(" failed (download or checksum error). Continuing with current version.\n");
    return;
  }

  try {
    await installUpdate(downloaded, latestTag, binaryPath);
    process.stderr.write(" done.\n");

    // Show release notes summary
    const bullets = extractBullets(releaseBody);
    if (bullets.length > 0) {
      process.stderr.write("\n  What's new:\n");
      for (const b of bullets.slice(0, 8)) {
        process.stderr.write(`    • ${b}\n`);
      }
      process.stderr.write("  Run /changelog for full details.\n");
    }
    process.stderr.write("\n");

    // Save state so /changelog can show notes later
    await saveState({
      lastCheck: Date.now(),
      latestVersion: latestTag,
      releaseNotes: releaseBody,
      updatedFrom: local,
      showChangelog: false,
    });

    // Re-exec the NEW binary (state is already saved above to prevent restart
    // loops). For a managed install this must go through the `current` symlink
    // we just swapped — binaryPath still points at the old versioned release.
    //
    // Args start at index 2, not 1: argv is [runtime, script, ...userArgs] for
    // node AND for Bun standalone builds (where argv[1] is /$bunfs/root/<name>).
    // slice(1) leaked that internal path through as the first user argument.
    try {
      execFileSync(relaunchPath(binaryPath), process.argv.slice(2), { stdio: "inherit" });
    } catch (e: any) {
      process.exit(e.status ?? 0);
    }
    process.exit(0);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    process.stderr.write(` failed (${reason}). Continuing with current version.\n`);
    await rm(downloaded, { force: true }).catch(() => {});
  }
}
