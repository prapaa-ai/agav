#!/usr/bin/env node
// Builds native/sandbox-win (agav-sandbox.exe) on a Windows host and smoke-tests it.
// Usage: node scripts/build-windows-sandbox-helper.mjs <outputDir>
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PROTOCOL = "agav-sandbox 1";

function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit", shell: false });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} exited with ${result.status}`);
}

let build;
try {
  const [outputDir, ...extra] = process.argv.slice(2);
  if (!outputDir || extra.length) throw new Error("Usage: node scripts/build-windows-sandbox-helper.mjs <outputDir>");
  if (process.platform !== "win32" || process.arch !== "x64") throw new Error("The Windows sandbox helper must be built on Windows x64.");
  build = mkdtempSync(join(tmpdir(), "agav-sandbox-build-"));
  const configure = ["-S", join(root, "native", "sandbox-win"), "-B", build, "-DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded", "-DCMAKE_BUILD_TYPE=Release"];
  if (process.env.AGAV_SANDBOX_TOOLCHAIN === "mingw") configure.push("-G", "MinGW Makefiles");
  else if (process.env.AGAV_SANDBOX_TOOLCHAIN && process.env.AGAV_SANDBOX_TOOLCHAIN !== "msvc") throw new Error("AGAV_SANDBOX_TOOLCHAIN must be msvc or mingw");
  run("cmake", configure);
  run("cmake", ["--build", build, "--config", "Release"]);
  const built = [join(build, "Release", "agav-sandbox.exe"), join(build, "agav-sandbox.exe")].find(path => existsSync(path));
  if (!built) throw new Error("agav-sandbox.exe was not produced by the build.");
  const version = spawnSync(built, ["--version"], { encoding: "utf8", shell: false, timeout: 10_000 });
  if (version.status !== 0 || version.stdout.trim() !== PROTOCOL) {
    throw new Error(`Helper smoke test failed: expected "${PROTOCOL}", got status ${version.status} "${(version.stdout ?? "").trim()}"`);
  }
  mkdirSync(resolve(outputDir), { recursive: true });
  const output = join(resolve(outputDir), "agav-sandbox-win32-x64.exe");
  copyFileSync(built, output);
  console.log(`Built Windows sandbox helper: ${output}`);
} catch (error) {
  console.error(`Cannot build Windows sandbox helper: ${error.message}`);
  process.exitCode = 1;
} finally {
  if (build) rmSync(build, { recursive: true, force: true });
}
