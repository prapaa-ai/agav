import { join, sep } from "node:path";
import { homedir, platform, arch } from "node:os";
import { readFile, writeFile, rename, chmod, copyFile, unlink, mkdir, symlink, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createWriteStream, createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { ensureDir } from "./fs.js";
import { VERSION } from "../version.js";
import { reinstallHint } from "./shell-hints.js";

const AGAV_DIR = join(homedir(), ".agav");
const UPDATE_STATE_FILE = join(AGAV_DIR, "update-state.json");
const CHECK_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const REPO = "prapaa-ai/agav";

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

function isNewer(remote: string, local: string): boolean {
  const r = remote.replace(/^v/, "").split(".").map(Number);
  const l = local.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((r[i] ?? 0) > (l[i] ?? 0)) return true;
    if ((r[i] ?? 0) < (l[i] ?? 0)) return false;
  }
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

async function downloadBinary(version: string): Promise<string | null> {
  const binaryName = getBinaryName();
  const url = `https://github.com/${REPO}/releases/download/${version}/${binaryName}`;
  const tmpPath = join(AGAV_DIR, `agav-update-${version}`);

  try {
    await ensureDir(AGAV_DIR);
    const res = await fetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(200_000),
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
        process.stderr.write(`\r  Downloading ${version} [${bar}] ${percent.toString().padStart(3)}% (${downloadedMb}/${totalMb} MB)`);
      } else {
        process.stderr.write(`\r  Downloading ${version} (${downloadedMb} MB)`);
      }
    };

    const progressStream = new Transform({
      transform(chunk, _encoding, callback) {
        downloadedBytes += chunk.length;
        renderProgress();
        callback(null, chunk);
      },
    });
    const fileStream = createWriteStream(tmpPath);
    await pipeline(res.body as any, progressStream, fileStream);
    renderProgress(true);

    // Verify against the published checksum before this ever becomes
    // executable. We are about to replace our own binary and re-exec it, so an
    // unverified download is a code-execution primitive. Fail closed: if the
    // .sha256 asset is missing or doesn't match, abandon the update.
    if (!(await verifyChecksum(tmpPath, `${url}.sha256`))) {
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

/** Compare a downloaded file against the release's published .sha256 asset. */
async function verifyChecksum(filePath: string, checksumUrl: string): Promise<boolean> {
  try {
    const res = await fetch(checksumUrl, {
      redirect: "follow",
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return false;
    // Format is `<hex>  <filename>` (sha256sum output).
    const expected = (await res.text()).trim().split(/\s+/)[0]?.toLowerCase();
    if (!expected || !/^[a-f0-9]{64}$/.test(expected)) return false;
    const actual = (await sha256File(filePath)).toLowerCase();
    return actual === expected;
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
  await symlink(target, tmpLink);
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
async function installUpdate(
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
    return;
  }

  const backupPath = `${binaryPath}.bak`;
  await safeMove(binaryPath, backupPath);
  await safeMove(downloadedPath, binaryPath);
  await chmod(binaryPath, 0o755);
  // Don't leave a stale copy of the previous version lying around.
  await rm(backupPath, { force: true });
}

/** Resolve the path the running process should re-exec after an update. */
function relaunchPath(binaryPath: string): string {
  const layout = detectManagedLayout(binaryPath);
  return layout ? join(layout.currentLink, layout.binaryName) : binaryPath;
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(path), hash);
  return hash.digest("hex");
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
  } catch {
    process.stderr.write(` failed (replace error).\n`);
    return false;
  }
}

export async function checkAndUpdate(): Promise<void> {
  const local = currentVersion();

  // Skip update check in CI, pipe mode, or non-TTY
  if (process.env["CI"] || process.env["AGAV_NO_UPDATE"] === "1" || !process.stdout.isTTY) {
    return;
  }

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

  const downloaded = await downloadBinary(latestTag);
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
  } catch {
    process.stderr.write(" failed (replace error). Continuing with current version.\n");
  }
}
