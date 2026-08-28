import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, it, expect, afterEach } from "vitest";
import { getCurrentBinaryPath, detectManagedLayout } from "../utils/auto-update.js";

const binaryName = process.platform === "win32" ? "agav.exe" : "agav";
const fixturePath = (...parts: string[]) => join(tmpdir(), "agav-tests", ...parts);

/** process.execPath is read-only in type terms but writable at runtime. */
function withExecPath<T>(value: string, fn: () => T): T {
  const original = process.execPath;
  Object.defineProperty(process, "execPath", { value, configurable: true });
  try {
    return fn();
  } finally {
    Object.defineProperty(process, "execPath", { value: original, configurable: true });
  }
}

describe("getCurrentBinaryPath", () => {
  afterEach(() => {
    // guard against a leaked override if a test throws mid-way
    expect(typeof process.execPath).toBe("string");
  });

  it("allows a compiled standalone binary", () => {
    const p = fixturePath("packages", "standalone", "releases", "0.1.3", binaryName);
    expect(withExecPath(p, getCurrentBinaryPath)).toBe(p);
  });

  it("allows a plain binary on PATH", () => {
    const p = fixturePath("bin", binaryName);
    expect(withExecPath(p, getCurrentBinaryPath)).toBe(p);
  });

  it("allows an arch-suffixed binary", () => {
    const p = fixturePath(process.platform === "win32" ? "agav-windows-x64.exe" : "agav-darwin-arm64");
    expect(withExecPath(p, getCurrentBinaryPath)).toBe(p);
  });

  // Regression: Bun sets argv[0] to the literal "bun" inside a compiled
  // binary, so the old argv[0]-based check returned null for every release
  // and auto-update never ran. execPath is the real path — verify we key off
  // it and are NOT fooled by argv[0].
  it("is not affected by Bun's argv[0] being the literal 'bun'", () => {
    const originalArgv = process.argv;
    process.argv = ["bun", "/$bunfs/root/agav-darwin-arm64", "update"];
    try {
      const p = fixturePath("packages", "standalone", "releases", "0.1.3", binaryName);
      expect(withExecPath(p, getCurrentBinaryPath)).toBe(p);
    } finally {
      process.argv = originalArgv;
    }
  });

  it.each([
    [fixturePath("bin", "node"), "node"],
    [fixturePath("bin", "bun"), "bun"],
    [fixturePath("bin", "deno"), "deno"],
    [fixturePath("bin", "npx"), "npx"],
    [fixturePath("bin", "tsx"), "tsx"],
  ])("refuses to overwrite the %s runtime", (p) => {
    expect(withExecPath(p, getCurrentBinaryPath)).toBeNull();
  });

  it("refuses a binary that isn't ours", () => {
    expect(withExecPath(fixturePath("bin", "something-else"), getCurrentBinaryPath)).toBeNull();
  });
});

describe("installer docs and scripts", () => {
  it("uses curl flags that preserve download progress while still failing on HTTP errors", () => {
    const readme = readFileSync(new URL("../../README.md", import.meta.url), "utf8");
    const installSh = readFileSync(new URL("../../scripts/install.sh", import.meta.url), "utf8");

    expect(readme).toContain("curl -fsSL https://agav.dev/install.sh | bash");
    expect(readme).toContain("curl -fsSL https://agav.dev/install.cmd -o install.cmd");
    expect(installSh).toContain('curl -fL --progress-bar "$url" -o "$output"');
    expect(installSh).toContain('curl -fsSL "$url" -o "$output"');
  });

  it("does not suppress PowerShell web request progress in install.cmd", () => {
    const installCmd = readFileSync(new URL("../../scripts/install.cmd", import.meta.url), "utf8");

    expect(installCmd).toContain("Invoke-WebRequest -UseBasicParsing -Uri '%INSTALLER_URL%' -OutFile '%TMP_PS1%'");
    expect(installCmd).not.toContain("$ProgressPreference='SilentlyContinue'");
  });

  // Fetching from a branch meant cmd users always ran whatever happened to be
  // on main rather than a released installer.
  it("fetches install.ps1 from the release host, not a git branch", () => {
    const installCmd = readFileSync(new URL("../../scripts/install.cmd", import.meta.url), "utf8");

    expect(installCmd).not.toContain("raw.githubusercontent.com");
    // www, not the apex: PowerShell 5.1 cannot follow the apex's 308.
    expect(installCmd).toContain("https://www.agav.dev/install.ps1");
  });

  it("verifies the download in every installer, and fails closed", () => {
    const installSh = readFileSync(new URL("../../scripts/install.sh", import.meta.url), "utf8");
    const installPs1 = readFileSync(new URL("../../scripts/install.ps1", import.meta.url), "utf8");

    // Nothing may skip verification except the documented opt-out.
    expect(installSh).toContain("checksum_abort");
    expect(installSh).toContain("AGAV_SKIP_CHECKSUM");
    expect(installPs1).toContain("SHA256");
    expect(installPs1).toContain("$DownloadUrl.sha256");
    expect(installPs1).toContain("Checksum verification failed");
  });

  // Windows cannot delete the image of a running process, so the installer has
  // to rename the old binary aside exactly like the in-app updater does.
  it("install.ps1 moves a running binary aside instead of overwriting it", () => {
    const installPs1 = readFileSync(new URL("../../scripts/install.ps1", import.meta.url), "utf8");

    expect(installPs1).toContain('$BackupPath = "$FinalPath.$PID.bak"');
    expect(installPs1).toMatch(/Move-Item -LiteralPath \$FinalPath -Destination \$BackupPath/);
  });

  // The expanded value written back as a literal destroys %USERPROFILE%-style
  // entries in the user's PATH.
  it("install.ps1 edits PATH without flattening REG_EXPAND_SZ", () => {
    const installPs1 = readFileSync(new URL("../../scripts/install.ps1", import.meta.url), "utf8");

    expect(installPs1).toContain("DoNotExpandEnvironmentNames");
    expect(installPs1).toContain("GetValueKind");
    expect(installPs1).not.toContain('[Environment]::SetEnvironmentVariable("PATH"');
  });

  // `file` is absent from slim containers; an absent tool is not a bad download.
  it("install.sh treats a missing `file` command as skippable, not fatal", () => {
    const installSh = readFileSync(new URL("../../scripts/install.sh", import.meta.url), "utf8");

    expect(installSh).toContain("if command -v file >/dev/null 2>&1; then");
    expect(installSh).not.toContain('file "$archive_path" 2>/dev/null || echo "unknown"');
  });
});

describe("detectManagedLayout", () => {
  it("recognises the installer's versioned layout", () => {
    const standaloneRoot = fixturePath(".agav", "packages", "standalone");
    const layout = detectManagedLayout(join(standaloneRoot, "releases", "0.1.2", binaryName));
    expect(layout).toEqual({
      releasesDir: join(standaloneRoot, "releases"),
      currentLink: join(standaloneRoot, "current"),
      binaryName,
    });
  });

  it("works for a relocated AGAV_HOME (detection is structural, not env-based)", () => {
    const standaloneRoot = fixturePath("relocated", "packages", "standalone");
    const layout = detectManagedLayout(join(standaloneRoot, "releases", "2.0.0", binaryName));
    expect(layout?.currentLink).toBe(join(standaloneRoot, "current"));
    expect(layout?.releasesDir).toBe(join(standaloneRoot, "releases"));
  });

  it("returns null for a plain binary", () => {
    expect(detectManagedLayout(fixturePath("bin", binaryName))).toBeNull();
  });

  it("returns null for a lookalike path", () => {
    expect(detectManagedLayout(fixturePath("a", "b", "releases", "0.1.0", binaryName))).toBeNull();
    expect(detectManagedLayout(fixturePath("a", "standalone", "other", "0.1.0", binaryName))).toBeNull();
  });

  it("returns null for a short path", () => {
    expect(detectManagedLayout(join(tmpdir(), binaryName))).toBeNull();
    expect(detectManagedLayout(binaryName)).toBeNull();
  });
});
