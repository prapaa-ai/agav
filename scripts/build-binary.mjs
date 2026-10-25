#!/usr/bin/env node
import { accessSync, constants, cpSync, mkdtempSync, mkdirSync, rmSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(root);

const [, , ...args] = process.argv;
let target = "native";
let withVoice = false;
let allFeatures = false;
let forceKillWorkers = false;
let targetSet = false;

for (const arg of args) {
  switch (arg) {
    case "--voice":
      withVoice = true;
      break;
    case "--all-features":
      allFeatures = true;
      break;
    case "--force-kill-workers":
      forceKillWorkers = true;
      break;
    case "--":
      break;
    case "--help":
    case "-h":
      console.log("Usage: node scripts/build-binary.mjs [native|all|darwin-arm64|darwin-x64|linux-x64|linux-arm64|windows-x64|windows-x64-baseline] [--voice|--all-features] [--force-kill-workers]");
      console.log("Default builds omit native features. --voice enables voice; all enables every feature on every target.");
      console.log("--force-kill-workers (Windows only) forcibly stops job/workflow workers running from the exact output executable before compiling. Running work is interrupted.");
      process.exit(0);
    default:
      if (targetSet) throw new Error(`Unexpected build argument: ${arg}`);
      target = arg;
      targetSet = true;
  }
}

if (target === "all") allFeatures = true;
if (allFeatures) withVoice = true;
if (forceKillWorkers && process.platform !== "win32") {
  throw new Error("--force-kill-workers is only supported on Windows.");
}
if (forceKillWorkers && target === "all") {
  throw new Error("--force-kill-workers requires a single output target, not all.");
}

const supportedTargets = new Set([
  "native", "darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64",
  "windows-x64", "windows-x64-baseline",
]);
if (target !== "all" && !supportedTargets.has(target)) throw new Error(`Unsupported binary target: ${target}`);

const host = `${process.platform}-${process.arch}`;
const voiceTarget = target === "native" ? host : target.startsWith("windows-") ? "win32-x64" : target;
if (target !== "all" && !["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64", "win32-x64"].includes(voiceTarget)) {
  throw new Error(`Unsupported native voice helper target: ${voiceTarget}`);
}

function helperPathFromDir() {
  if (!process.env.AGAV_VOICE_HELPER_DIR) return "";
  const suffix = voiceTarget === "win32-x64" ? ".exe" : "";
  return resolve(join(process.env.AGAV_VOICE_HELPER_DIR, `agav-voice-${voiceTarget}${suffix}`));
}

function isReadableFile(path) {
  try {
    accessSync(path, constants.R_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, { stdio: "inherit", shell: false, ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed (${result.status ?? result.signal}).`);
}

function runCapture(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, { encoding: "utf8", shell: false, ...options });
  if (result.error) throw result.error;
  return result;
}

function forceKillOutputWorkers(output) {
  // Only the binary about to be replaced, and only its private background worker modes.
  // Query and stop in one PowerShell invocation; fail closed if enumeration or stopping fails.
  const quotedOutput = output.replaceAll("'", "''");
  const name = basename(output).replaceAll("'", "''");
  // No backslashes, backticks or `${` below: this text is a JS template literal and the PowerShell
  // must see characters like quotes and backslashes only via [char] codes.
  const script = `
$ErrorActionPreference = 'Stop'
$target = '${quotedOutput}'
$flags = @('--internal-background-jobs-supervisor', '--internal-background-jobs-tick', '--internal-workflow-runner')
$bs = [char]92
$q = [char]34
$tab = [char]9

# First argument after the executable, parsed with the Windows CRT command-line rules (what the
# process itself sees as argv[1]): the executable token is taken literally (quoted, or the exact
# target path, or up to the first space/tab); arguments split on unquoted space/tab; 2n backslashes
# before a quote give n backslashes and toggle quoting, 2n+1 give n backslashes and a literal quote.
function Get-FirstArgument([string]$CommandLine) {
  if ([string]::IsNullOrEmpty($CommandLine)) { return $null }
  $n = $CommandLine.Length
  $i = 0
  $quotedTarget = [string]$q + $target + $q
  if ($CommandLine.StartsWith($quotedTarget, [StringComparison]::OrdinalIgnoreCase)) {
    $i = $quotedTarget.Length
  } elseif ($CommandLine.StartsWith($target, [StringComparison]::OrdinalIgnoreCase) -and
            ($CommandLine.Length -eq $target.Length -or $CommandLine[$target.Length] -eq ' ' -or $CommandLine[$target.Length] -eq $tab)) {
    $i = $target.Length
  } elseif ($CommandLine[0] -eq $q) {
    $end = $CommandLine.IndexOf($q, 1)
    if ($end -lt 0) { return $null }
    $i = $end + 1
  } else {
    while ($i -lt $n -and $CommandLine[$i] -ne ' ' -and $CommandLine[$i] -ne $tab) { $i++ }
  }
  while ($i -lt $n -and ($CommandLine[$i] -eq ' ' -or $CommandLine[$i] -eq $tab)) { $i++ }
  if ($i -ge $n) { return $null }
  $arg = New-Object System.Text.StringBuilder
  $inQuotes = $false
  while ($i -lt $n) {
    $c = $CommandLine[$i]
    if ($c -eq $bs) {
      $count = 0
      while ($i -lt $n -and $CommandLine[$i] -eq $bs) { $count++; $i++ }
      if ($i -lt $n -and $CommandLine[$i] -eq $q) {
        [void]$arg.Append($bs, [int][math]::Floor($count / 2))
        if ($count % 2 -eq 1) { [void]$arg.Append($q); $i++ }
      } else {
        [void]$arg.Append($bs, $count)
      }
      continue
    }
    if ($c -eq $q) {
      if ($inQuotes -and ($i + 1) -lt $n -and $CommandLine[$i + 1] -eq $q) { [void]$arg.Append($q); $i += 2; continue }
      $inQuotes = -not $inQuotes
      $i++
      continue
    }
    if (-not $inQuotes -and ($c -eq ' ' -or $c -eq $tab)) { break }
    [void]$arg.Append($c)
    $i++
  }
  return $arg.ToString()
}

# Exact (ordinal, case-sensitive like cli.tsx) match of the first argument against a worker mode.
function Test-WorkerMode($process) {
  $first = Get-FirstArgument $process.CommandLine
  if ($null -eq $first) { return $false }
  foreach ($flag in $flags) { if ([string]::Equals($first, $flag, [StringComparison]::Ordinal)) { return $true } }
  return $false
}

$workers = @(Get-CimInstance Win32_Process -Filter "name = '${name}'" | Where-Object {
  $candidate = $_
  [string]::Equals($candidate.ExecutablePath, $target, [StringComparison]::OrdinalIgnoreCase) -and
  (Test-WorkerMode $candidate)
})
foreach ($worker in $workers) {
  $current = Get-CimInstance Win32_Process -Filter "ProcessId = $($worker.ProcessId)"
  if ($null -eq $current) { continue }
  if ($current.CreationDate -ne $worker.CreationDate -or
      -not [string]::Equals($current.ExecutablePath, $target, [StringComparison]::OrdinalIgnoreCase) -or
      -not [string]::Equals($current.CommandLine, $worker.CommandLine, [StringComparison]::Ordinal) -or
      -not (Test-WorkerMode $current)) {
    throw "Worker PID $($worker.ProcessId) changed identity; refusing to stop it."
  }
  Stop-Process -Id $worker.ProcessId -Force -ErrorAction Stop
  Write-Output "Stopped background worker PID $($worker.ProcessId)"
}
`;
  const result = runCapture("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")]);
  if (result.status !== 0) throw new Error(`Failed to stop background workers for ${output}: ${result.stderr?.trim() || result.error?.message || result.status}.`);
  if (result.stdout?.trim()) console.log(result.stdout.trim());
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)}K`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}M`;
}

function buildAll() {
  const helperDir = process.env.AGAV_VOICE_HELPER_DIR;
  if (!helperDir) {
    throw new Error("all builds every feature on every target. Set AGAV_VOICE_HELPER_DIR to a directory of matching prebuilt native helpers (agav-voice-<platform>-<arch>[.exe]).");
  }
  for (const helperTarget of ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64", "win32-x64"]) {
    const suffix = helperTarget === "win32-x64" ? ".exe" : "";
    const helper = join(helperDir, `agav-voice-${helperTarget}${suffix}`);
    if (!isReadableFile(helper)) {
      throw new Error(`Missing readable helper for ${helperTarget}: ${helper} (AGAV_VOICE_HELPER_DIR).`);
    }
  }
  for (const platform of ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64", "windows-x64", "windows-x64-baseline"]) {
    const env = { ...process.env, AGAV_VOICE_HELPER_PATH: "" };
    run(process.execPath, [fileURLToPath(import.meta.url), platform, "--all-features"], { env });
  }
}

if (target === "all") {
  buildAll();
  process.exit(0);
}

if (withVoice && !process.env.AGAV_VOICE_HELPER_PATH && process.env.AGAV_VOICE_HELPER_DIR) {
  process.env.AGAV_VOICE_HELPER_PATH = helperPathFromDir();
}
if (withVoice && voiceTarget !== host && !process.env.AGAV_VOICE_HELPER_PATH) {
  throw new Error(`Cross-target ${target} requires AGAV_VOICE_HELPER_PATH pointing to a matching ${voiceTarget} prebuilt helper.`);
}

const bundle = join(root, "source/voice/bundled-runtime.ts");
const scratch = mkdtempSync(join(tmpdir(), "agav-binary-"));
const originalBundle = join(scratch, "bundled-runtime.ts");
cpSync(bundle, originalBundle);
try {
  if (withVoice) {
    let helper = process.env.AGAV_VOICE_HELPER_PATH;
    if (helper) {
      helper = resolve(helper);
    } else {
      const voiceAssets = join(scratch, "voice-assets");
      run(process.execPath, [join(root, "scripts/build-voice-helper.mjs"), voiceTarget, voiceAssets]);
      helper = join(voiceAssets, `agav-voice-${voiceTarget}${voiceTarget === "win32-x64" ? ".exe" : ""}`);
    }
    run(process.execPath, [join(root, "scripts/embed-voice-helper.mjs"), voiceTarget, helper, bundle]);

    if (voiceTarget === host) {
      const protocol = runCapture(helper, ["--protocol-version"], { timeout: 10_000 });
      if (protocol.status !== 0 || protocol.stdout.trim() !== "1") {
        throw new Error("Native voice helper must report --protocol-version 1.");
      }
    }
  } else {
    console.log("Building without bundled voice (use --voice to include the native helper).");
  }

  run(process.execPath, [join(root, "scripts/gen-bundled-skills.mjs")]);
  const bun = process.platform === "win32" ? "bun.exe" : "bun";
  const version = spawnSync(bun, ["--version"], { stdio: "ignore", shell: false });
  if (version.error) throw new Error("Bun is required to compile Agav; install Bun before running this script.");

  mkdirSync(join(root, "dist"), { recursive: true });
  let outputName = target === "native" ? "agav" : `agav-${target}`;
  if (voiceTarget === "win32-x64") outputName += ".exe";
  console.log(`Building for ${target} (native voice: ${withVoice})...`);

  const output = join(root, "dist", outputName);
  if (forceKillWorkers) forceKillOutputWorkers(output);
  const buildArgs = ["build", "source/cli.tsx", "--compile"];
  if (!(target === "native" || (host === "win32-x64" && voiceTarget === host))) {
    buildArgs.push(`--target=bun-${target}`);
  }
  buildArgs.push("--outfile", output);
  try {
    run(bun, buildArgs);
  } catch (error) {
    if (process.platform === "win32") {
      console.error(`Binary compilation failed; expected output: ${output}`);
      console.error(forceKillWorkers
        ? "If Bun reported EPERM, --force-kill-workers only stops background workers running from this exact path. Other Agav sessions or programs may still have the executable open. Close them and retry from a separate terminal; otherwise check file/directory permissions and antivirus protection."
        : "If Bun reported EPERM while moving the executable, Windows may have the target locked. Close Agav sessions and background supervisors running from this path, then retry from a separate terminal. If nothing is using it, check file/directory permissions and antivirus protection. No processes were stopped and the output path was not changed.");
    }
    throw error;
  }
  console.log(`Built: dist/${outputName} (${formatSize(statSync(output).size)})`);
} finally {
  cpSync(originalBundle, bundle);
  rmSync(scratch, { recursive: true, force: true });
}
