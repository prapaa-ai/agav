import { join } from "node:path";
import { homedir, platform, arch } from "node:os";
import { readFile, writeFile, rename, chmod, copyFile, unlink } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { ensureDir } from "./fs.js";
import { VERSION } from "../version.js";

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
  const osName = os === "darwin" ? "darwin" : "linux";
  const archName = cpu === "arm64" ? "arm64" : "x64";
  return `agav-${osName}-${archName}`;
}

async function downloadBinary(version: string): Promise<string | null> {
  const binaryName = getBinaryName();
  const url = `https://github.com/${REPO}/releases/download/${version}/${binaryName}`;
  const tmpPath = join(AGAV_DIR, `agav-update-${version}`);

  try {
    const res = await fetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok || !res.body) return null;

    const fileStream = createWriteStream(tmpPath);
    await pipeline(res.body as any, fileStream);
    await chmod(tmpPath, 0o755);
    return tmpPath;
  } catch {
    return null;
  }
}

function getCurrentBinaryPath(): string | null {
  try {
    const argv0 = process.argv[0];
    if (!argv0) return null;
    const base = argv0.split("/").pop() ?? "";
    // Never overwrite the system Node/Bun binary
    if (/^(node|bun|deno|npx|tsx)/.test(base)) return null;
    // Only update if the binary looks like a Agav binary
    if (!base.startsWith("agav")) return null;
    return argv0;
  } catch {
    return null;
  }
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
    process.stderr.write(`  Update manually: npm update -g agav-cli\n`);
    return false;
  }

  process.stderr.write(`  Downloading ${latestTag}...`);
  const downloaded = await downloadBinary(latestTag);
  if (!downloaded) {
    process.stderr.write(` failed.\n`);
    return false;
  }

  try {
    const backupPath = `${binaryPath}.bak`;
    await safeMove(binaryPath, backupPath);
    await safeMove(downloaded, binaryPath);
    await chmod(binaryPath, 0o755);
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
    process.stderr.write(" failed (download error). Continuing with current version.\n");
    return;
  }

  try {
    const backupPath = `${binaryPath}.bak`;
    await safeMove(binaryPath, backupPath);
    await safeMove(downloaded, binaryPath);
    await chmod(binaryPath, 0o755);
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

    // Re-exec with the new binary (state is already saved above to prevent restart loops)
    try {
      execFileSync(binaryPath, process.argv.slice(1), { stdio: "inherit" });
    } catch (e: any) {
      process.exit(e.status ?? 0);
    }
    process.exit(0);
  } catch {
    process.stderr.write(" failed (replace error). Continuing with current version.\n");
  }
}
