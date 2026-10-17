import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

// Real CMake configure/build steps can exceed Vitest's 5s default on shared CI runners.
const nativeBuildTestTimeoutMs = 30_000;

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const available = (command: string) => spawnSync(command, ["--version"], { encoding: "utf8" }).status === 0;
const cmakeAvailable = available("cmake");
const crossTools = ["x86_64-w64-mingw32-gcc", "x86_64-w64-mingw32-g++", "x86_64-w64-mingw32-objdump"];
const crossAvailable = cmakeAvailable && crossTools.every(available);

// Use the production CMake configuration, but local dependency stand-ins and a
// thread/exception/iostream probe: no downloads or production source mutations.
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "agav-mingw-runtime-")); roots.push(root);
  for (const dir of ["source", "whisper", "miniaudio"]) mkdirSync(join(root, dir));
  copyFileSync("native/voice/CMakeLists.txt", join(root, "source/CMakeLists.txt"));
  copyFileSync("native/voice/Info.plist", join(root, "source/Info.plist"));
  writeFileSync(join(root, "whisper/CMakeLists.txt"), "cmake_minimum_required(VERSION 3.24)\nadd_library(whisper INTERFACE)\n");
  writeFileSync(join(root, "source/audio.c"), "void audio_probe(void) {}\n");
  writeFileSync(join(root, "source/main.cpp"), `
#include <iostream>
#include <stdexcept>
#include <thread>
int main() {
    int value = 0;
    std::thread worker([&] { value = 42; });
    worker.join();
    try { throw std::runtime_error("runtime probe"); }
    catch (const std::exception& error) { std::cout << error.what() << value << '\\n'; }
    return value == 42 ? 0 : 1;
}
`);
  const nativeToolchain = join(root, "native.cmake");
  writeFileSync(nativeToolchain, "set(CMAKE_SYSTEM_NAME ${CMAKE_HOST_SYSTEM_NAME})\nset(CMAKE_SYSTEM_PROCESSOR x86_64)\n");
  return { root, configure(avx2: boolean, extra: string[] = []) {
    const build = join(root, avx2 ? "avx2" : "baseline");
    const result = spawnSync("cmake", ["-S", join(root, "source"), "-B", build, "-G", "Unix Makefiles",
      "-DBUILD_TESTING=OFF", "-DCMAKE_BUILD_TYPE=Release", "-DAGAV_VOICE_METAL=OFF",
      `-DAGAV_VOICE_AVX2=${avx2 ? "ON" : "OFF"}`, `-DCMAKE_TOOLCHAIN_FILE=${nativeToolchain}`,
      `-DFETCHCONTENT_SOURCE_DIR_WHISPER=${join(root, "whisper")}`,
      `-DFETCHCONTENT_SOURCE_DIR_MINIAUDIO=${join(root, "miniaudio")}`, ...extra], { encoding: "utf8" });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    return build;
  } };
}

describe("MinGW voice runtime linkage", () => {
  it.skipIf(!cmakeAvailable || process.platform === "win32").each([false, true])("statically links every MinGW runtime (AVX2=%s)", avx2 => {
    const f = fixture();
    // Setting MINGW exercises the scoped link policy even on hosts without a
    // cross-compiler. This checks generated commands, not a Windows executable.
    const build = f.configure(avx2, ["-DMINGW=TRUE"]);
    const link = readFileSync(join(build, "CMakeFiles/agav-voice.dir/link.txt"), "utf8");
    for (const option of ["-static", "-static-libgcc", "-static-libstdc++"]) {
      expect(link.split(/\s+/)).toContain(option);
    }
  }, nativeBuildTestTimeoutMs);

  it.skipIf(!cmakeAvailable || process.platform === "win32")("does not force static system libraries on non-MinGW toolchains", () => {
    const build = fixture().configure(false);
    const link = readFileSync(join(build, "CMakeFiles/agav-voice.dir/link.txt"), "utf8");
    expect(link.split(/\s+/)).not.toContain("-static");
    const compiled = spawnSync("cmake", ["--build", build, "--parallel", "2"], { encoding: "utf8" });
    expect(compiled.status, compiled.stdout + compiled.stderr).toBe(0);
    const probe = spawnSync(join(build, "agav-voice"), [], { encoding: "utf8" });
    expect(probe.status, probe.stderr).toBe(0);
    expect(probe.stdout).toBe("runtime probe42\n");
  }, nativeBuildTestTimeoutMs);

  it.skipIf(!crossAvailable).each([false, true])("builds PE without MinGW runtime DLL imports (AVX2=%s)", avx2 => {
    const f = fixture();
    const toolchain = join(f.root, "mingw.cmake");
    writeFileSync(toolchain, `set(CMAKE_SYSTEM_NAME Windows)\nset(CMAKE_SYSTEM_PROCESSOR AMD64)\nset(CMAKE_C_COMPILER ${crossTools[0]})\nset(CMAKE_CXX_COMPILER ${crossTools[1]})\n`);
    const build = f.configure(avx2, [`-DCMAKE_TOOLCHAIN_FILE=${toolchain}`]);
    const compiled = spawnSync("cmake", ["--build", build, "--parallel", "2"], { encoding: "utf8" });
    expect(compiled.status, compiled.stdout + compiled.stderr).toBe(0);
    const imports = spawnSync(crossTools[2]!, ["-p", join(build, "agav-voice.exe")], { encoding: "utf8" });
    expect(imports.status, imports.stderr).toBe(0);
    expect(imports.stdout).toMatch(/DLL Name:/i);
    expect(imports.stdout).not.toMatch(/DLL Name:\s*(?:libwinpthread-1|libgcc_s[^\s]*|libstdc\+\+-6)\.dll/i);
  }, nativeBuildTestTimeoutMs);
});
