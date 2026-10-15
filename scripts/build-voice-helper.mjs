#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rename, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const [target, directory, ...extra] = process.argv.slice(2);
const targets = ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64", "win32-x64"];
let scratch;
let staging;
const started = performance.now();
function run(command, args, timeout) {
  const result = spawnSync(command, args, { stdio: "inherit", shell: false, timeout });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed (${result.status ?? result.signal}).`);
}
try {
  if (!targets.includes(target) || !directory || extra.length) throw new Error("Usage: build-voice-helper.mjs <darwin-arm64|darwin-x64|linux-arm64|linux-x64|win32-x64> <outputDir>");
  if (target !== `${process.platform}-${process.arch}`) throw new Error(`Build ${target} on its native runner; current host is ${process.platform}-${process.arch}.`);
  scratch = await mkdtemp(join(tmpdir(), "agav-native-voice-"));
  const output = resolve(directory);
  const args = ["-S", join(root, "native", "voice"), "-B", scratch, "-DCMAKE_BUILD_TYPE=Release", "-DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded"];
  // Use CMake's native Visual Studio generator (not Git Bash's MinGW).
  if (process.platform === "win32") args.push("-A", "x64");
  if (process.platform === "linux") args.push("-DCMAKE_EXE_LINKER_FLAGS=-static-libstdc++ -static-libgcc");
  if (process.env.AGAV_VOICE_METAL !== undefined) {
    const metal = process.env.AGAV_VOICE_METAL.toUpperCase();
    if (!["ON", "OFF"].includes(metal)) throw new Error("AGAV_VOICE_METAL must be ON or OFF");
    args.push(`-DAGAV_VOICE_METAL=${metal}`);
  }
  args.push("-DAGAV_VOICE_AVX2=OFF");
  run("cmake", args);
  run("cmake", ["--build", scratch, "--config", "Release", "--parallel", "4"]);
  run("ctest", ["--test-dir", scratch, "-C", "Release", "--output-on-failure"]);
  const binary = process.platform === "win32" ? join(scratch, "Release", "agav-voice.exe") : join(scratch, "agav-voice");
  if (process.platform === "darwin") run("codesign", ["--sign", "-", "--force", binary]);
  const protocol = spawnSync(binary, ["--protocol-version"], { encoding: "utf8", shell: false, timeout: 10_000 });
  if (protocol.error) throw protocol.error;
  if (protocol.status !== 0 || protocol.stdout.trim() !== "1" || protocol.stderr.trim()) throw new Error("Native voice helper must report --protocol-version 1");
  const smokeStarted = performance.now();
  run(binary, ["--self-test"], 30_000);
  const smokeMs = Math.round(performance.now() - smokeStarted);
  await mkdir(output, { recursive: true });
  const name = `agav-voice-${target}${process.platform === "win32" ? ".exe" : ""}`;
  // Stage on the destination filesystem so a failed copy never publishes a
  // truncated helper; rename replaces an existing artifact atomically.
  staging = await mkdtemp(join(output, ".agav-voice-"));
  await copyFile(binary, join(staging, name));
  const { size } = await stat(join(staging, name));
  if (process.arch === "x64") {
    // A distinct build tree prevents optimized ggml objects leaking into the baseline.
    const optimizedBuild = join(scratch, "avx2");
    const optimizedArgs = args.map(arg => arg === scratch ? optimizedBuild : arg === "-DAGAV_VOICE_AVX2=OFF" ? "-DAGAV_VOICE_AVX2=ON" : arg);
    run("cmake", optimizedArgs);
    run("cmake", ["--build", optimizedBuild, "--config", "Release", "--parallel", "4"]);
    const optimizedBinary = process.platform === "win32" ? join(optimizedBuild, "Release", "agav-voice.exe") : join(optimizedBuild, "agav-voice");
    if (process.platform === "darwin") run("codesign", ["--sign", "-", "--force", optimizedBinary]);
    const probe = spawnSync(binary, ["--supports-avx2"], { encoding: "utf8", shell: false, timeout: 10_000 });
    if (!probe.error && probe.status === 0 && probe.stdout.trim() === "1" && !probe.stderr.trim()) {
      run("ctest", ["--test-dir", optimizedBuild, "-C", "Release", "--output-on-failure"]);
      run(optimizedBinary, ["--self-test"], 30_000);
    }
    await copyFile(optimizedBinary, join(staging, `${name}.avx2`));
    await rename(join(staging, `${name}.avx2`), join(output, `${name}.avx2`));
  }
  await rename(join(staging, name), join(output, name));
  console.log(`Native voice helper ${target}: ${size} bytes; self-test ${smokeMs} ms; build/test/package ${Math.round(performance.now() - started)} ms.`);
} catch (error) {
  console.error(`Cannot build native voice helper: ${error.message}. Install CMake and a native C/C++ toolchain, or set AGAV_VOICE_HELPER_PATH to a matching prebuilt helper when building Agav.`);
  process.exitCode = 1;
} finally {
  if (staging) await rm(staging, { recursive: true, force: true });
  if (scratch) await rm(scratch, { recursive: true, force: true });
}
