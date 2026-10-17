#!/usr/bin/env node
import { accessSync, constants, cpSync, mkdtempSync, mkdirSync, rmSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(root);

const [, , ...args] = process.argv;
let target = "native";
let withVoice = false;
let allFeatures = false;
let targetSet = false;

for (const arg of args) {
  switch (arg) {
    case "--voice":
      withVoice = true;
      break;
    case "--all-features":
      allFeatures = true;
      break;
    case "--":
      break;
    case "--help":
    case "-h":
      console.log("Usage: node scripts/build-binary.mjs [native|all|darwin-arm64|darwin-x64|linux-x64|linux-arm64|windows-x64|windows-x64-baseline] [--voice|--all-features]");
      console.log("Default builds omit native features. --voice enables voice; all enables every feature on every target.");
      process.exit(0);
    default:
      if (targetSet) throw new Error(`Unexpected build argument: ${arg}`);
      target = arg;
      targetSet = true;
  }
}

if (target === "all") allFeatures = true;
if (allFeatures) withVoice = true;

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
  const buildArgs = ["build", "source/cli.tsx", "--compile"];
  if (!(target === "native" || (host === "win32-x64" && voiceTarget === host))) {
    buildArgs.push(`--target=bun-${target}`);
  }
  buildArgs.push("--outfile", output);
  run(bun, buildArgs);
  console.log(`Built: dist/${outputName} (${formatSize(statSync(output).size)})`);
} finally {
  cpSync(originalBundle, bundle);
  rmSync(scratch, { recursive: true, force: true });
}
