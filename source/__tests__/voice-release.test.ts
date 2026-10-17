import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

// Exercise the Node entrypoint used by package builds in an isolated repository. Native compilation
// and Bun are stand-ins: no network/toolchain or production source mutation.
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "agav-binary-test-"));
  roots.push(root);
  for (const dir of ["scripts", "source/voice", "bin"]) mkdirSync(join(root, dir), { recursive: true });
  copyFileSync("scripts/build-binary.mjs", join(root, "scripts/build-binary.mjs"));
  writeFileSync(join(root, "source/voice/bundled-runtime.ts"), "original stub\n");
  writeFileSync(join(root, "scripts/gen-bundled-skills.mjs"), "");
  writeFileSync(join(root, "scripts/embed-voice-helper.mjs"), `
    import { readFileSync, writeFileSync } from 'node:fs';
    const [target, helper, output] = process.argv.slice(2);
    readFileSync(helper);
    if (process.env.FAIL_EMBED) { console.error('Invalid executable architecture'); process.exit(1); }
    writeFileSync(output, 'embedded ' + target);
  `);
  writeFileSync(join(root, "scripts/build-voice-helper.mjs"), `
    import { mkdirSync, writeFileSync, chmodSync } from 'node:fs';
    import { join } from 'node:path';
    if (process.env.FAIL_NATIVE) { console.error('CMake is required'); process.exit(1); }
    const [target, dir] = process.argv.slice(2);
    mkdirSync(dir, { recursive: true });
    const helper = join(dir, 'agav-voice-' + target + (target.startsWith('win32') ? '.exe' : ''));
    writeFileSync(helper, '#!/bin/sh\\nprintf "1\\\\n"\\n');
    chmodSync(helper, 0o755);
  `);
  const bun = join(root, "bin/bun");
  writeFileSync(bun, `#!/usr/bin/env node
    const fs = require('node:fs');
    const args = process.argv.slice(2);
    if (args[0] === '--version') process.exit(0);
    const bundle = fs.readFileSync('source/voice/bundled-runtime.ts');
    fs.writeFileSync('compiled-bundle', bundle);
    fs.writeFileSync('bun-args', args.join('\\n'));
    fs.writeFileSync(args[args.indexOf('--outfile') + 1], bundle);
    process.exit(Number(process.env.FAIL_BUN || 0));
  `);
  chmodSync(bun, 0o755);
  const helper = join(root, "prebuilt");
  writeFileSync(helper, '#!/bin/sh\nprintf "${HELPER_PROTOCOL:-1}\\n"\n');
  chmodSync(helper, 0o755);
  return { root, helper, run: (args: string[], env: NodeJS.ProcessEnv = {}) => spawnSync(process.execPath, [join(root, "scripts/build-binary.mjs"), ...args], {
    cwd: tmpdir(), encoding: "utf8", env: { ...process.env, AGAV_VOICE_HELPER_PATH: "", AGAV_VOICE_HELPER_DIR: "", PATH: `${join(root, "bin")}:${process.env.PATH}`, ...env },
  }) };
}

describe("native voice release packaging", () => {
  it("builds and embeds each native helper before compiling the main executable", () => {
    const workflow = parse(readFileSync(".github/workflows/release.yml", "utf8"));
    const job = workflow.jobs["build-binaries"];
    expect(Object.fromEntries(job.strategy.matrix.include.map((entry: any) => [entry.target, entry.os]))).toEqual({
      "darwin-arm64": "macos-latest", "darwin-x64": "macos-15-intel", "linux-x64": "ubuntu-latest", "linux-arm64": "ubuntu-24.04-arm",
      "windows-x64": "windows-latest", "windows-x64-baseline": "windows-latest",
    });
    const embedIndex = job.steps.findIndex((step: any) => step.run?.includes("scripts/embed-voice-helper.mjs"));
    const compileIndex = job.steps.findIndex((step: any) => step.name === "Build binary");
    expect(embedIndex).toBeGreaterThan(-1);
    expect(embedIndex).toBeLessThan(compileIndex);
    const embed = job.steps[embedIndex].run;
    expect(embed).toContain('process.platform + "-" + process.arch');
    expect(embed.indexOf("scripts/build-voice-helper.mjs")).toBeLessThan(embed.indexOf("scripts/embed-voice-helper.mjs"));
    expect(embed).toContain("mktemp -d");
    expect(embed).toContain("source/voice/bundled-runtime.ts");
    expect(embed).toContain('HELPER="$HELPER.exe"');
    expect(workflow.jobs["build-voice-helper"]).toBeUndefined();
    expect(workflow.jobs.release.needs).toEqual(["check-version", "build-binaries"]);
    const upload = job.steps.find((step: any) => step.uses?.startsWith("actions/upload-artifact"));
    expect(upload.with.path).not.toContain("voice");
    const text = readFileSync(".github/workflows/release.yml", "utf8");
    expect(text).not.toContain("voice-runtime-manifest");
    expect(text).not.toContain("LICENSE.");
    const prepare = workflow.jobs.release.steps.find((step: any) => step.name === "Prepare release assets").run;
    expect(prepare).toContain('for dir in artifacts/agav-*');
    expect(prepare).toContain('"$target.exe"');
  });
  it("routes package binary builds through the fail-closed wrapper", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8"));
    expect(pkg.scripts["build:binary"]).toBe("node scripts/build-binary.mjs native");
    expect(pkg.scripts["build:binary:voice"]).toBe("node scripts/build-binary.mjs native --voice");
    expect(pkg.scripts["build:binary:all"]).toBe("node scripts/build-binary.mjs all");
    const builder = readFileSync("scripts/build-voice-helper.mjs", "utf8");
    expect(builder).toContain('run("ctest"');
    expect(builder).toContain("-static-libstdc++ -static-libgcc");
    expect(builder).toContain("CMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded");
    expect(builder).not.toContain("LICENSE.");
  });
  it("uses embedded Metal and Accelerate on macOS with a portable static CPU fallback", () => {
    const cmake = readFileSync("native/voice/CMakeLists.txt", "utf8");
    expect(cmake).toContain('option(AGAV_VOICE_METAL "Enable Apple\'s optional Metal inference backend" ${APPLE})');
    expect(cmake).toContain('set(GGML_ACCELERATE ${APPLE}');
    expect(cmake).toContain('set(GGML_METAL_EMBED_LIBRARY ${AGAV_VOICE_METAL}');
    expect(cmake).toContain('set(BUILD_SHARED_LIBS OFF');
    const disabled = cmake.match(/foreach\(feature NATIVE ([^)]+)\)/)?.[1].split(" ");
    expect(disabled).toEqual(expect.arrayContaining(["AVX", "AVX2", "FMA", "F16C", "AVX512", "CPU_ALL_VARIANTS", "BACKEND_DL", "OPENMP"]));
    expect(cmake).toContain('set(GGML_SSE42 ON');
    expect(cmake).not.toContain('set(GGML_NATIVE ON');
    expect(cmake).not.toContain('-march=native');
    expect(cmake).toContain('add_test(NAME voice-protocol-version');
    expect(cmake).toContain('add_test(NAME voice-self-test');
    expect(cmake).not.toContain('set(CMAKE_WARN_DEPRECATED OFF');
    const builder = readFileSync("scripts/build-voice-helper.mjs", "utf8");
    expect(builder).toContain('args.push("-G", "Visual Studio 17 2022", "-A", "x64")');
    expect(builder).toContain('args.push("-G", "MinGW Makefiles", "-DCMAKE_EXE_LINKER_FLAGS=-static-libstdc++ -static-libgcc")');
    expect(builder).toContain('const override = process.env.AGAV_VOICE_TOOLCHAIN;');
    expect(builder).toContain('if (hasMinGWToolchain()) return "mingw";');
    expect(builder).toContain('if (hasMsvcToolchain()) return "msvc";');
    expect(builder).toContain('return override;');
    expect(builder).toContain('"Microsoft.VisualStudio.Component.VC.Tools.x86.x64"');
    expect(builder).toContain('["gcc.exe", "g++.exe", "mingw32-make.exe"]');
    expect(builder).toContain('No supported Windows C/C++ toolchain found.');
    expect(builder).toContain('process.platform === "win32" && windowsToolchain === "msvc" ? ["Release"]');
    expect(builder).toContain('const optimizedBinary = binaryPath(optimizedBuild)');
    expect(builder).toContain('const testEnv = process.platform === "win32" && windowsToolchain === "mingw"');
    expect(builder).toContain('PYTHONUTF8: "1"');
    expect(builder).toContain('run("ctest", ["--test-dir", scratch, "-C", "Release", "--output-on-failure"], undefined, testEnv)');
    expect(builder).toContain('run("ctest", ["--test-dir", optimizedBuild, "-C", "Release", "--output-on-failure"], undefined, testEnv)');
    expect(builder).toContain('args.push(`-DAGAV_VOICE_METAL=${metal}`)');
    expect(builder).toContain('run(binary, ["--self-test"], 30_000)');
    expect(builder).toContain('await rename(join(staging, name), join(output, name))');
    expect(builder).toContain('${size} bytes');
  });
  it.skipIf(process.platform === "win32").each([undefined, "OFF", "ON"])("forwards the Metal configure override %s and publishes only a verified helper", metal => {
    const root = mkdtempSync(join(tmpdir(), "agav-native-builder-test-")); roots.push(root);
    mkdirSync(join(root, "scripts")); mkdirSync(join(root, "bin"));
    copyFileSync("scripts/build-voice-helper.mjs", join(root, "scripts/build-voice-helper.mjs"));
    const tool = join(root, "bin/cmake");
    writeFileSync(tool, `#!/usr/bin/env node
      const fs = require('node:fs'); const path = require('node:path');
      const args = process.argv.slice(2);
      fs.appendFileSync(process.env.TOOL_LOG, JSON.stringify(args) + '\\n');
      if (args.includes('-B')) {
        const scratch = args[args.indexOf('-B') + 1];
        fs.mkdirSync(scratch, { recursive: true });
        const binary = path.join(scratch, 'agav-voice');
        fs.writeFileSync(binary, '#!/bin/sh\\nif [ "$1" = "--protocol-version" ]; then printf "1\\\\n"; else printf "self-test passed\\\\n"; fi\\n');
        fs.chmodSync(binary, 0o755);
      }
    `); chmodSync(tool, 0o755);
    for (const name of ["ctest", "codesign"]) {
      writeFileSync(join(root, "bin", name), "#!/bin/sh\nexit 0\n"); chmodSync(join(root, "bin", name), 0o755);
    }
    const output = join(root, "output"); const log = join(root, "tool.log");
    const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${join(root, "bin")}:${process.env.PATH}`, TOOL_LOG: log };
    delete env.AGAV_VOICE_METAL;
    if (metal !== undefined) env.AGAV_VOICE_METAL = metal;
    const result = spawnSync(process.execPath, [join(root, "scripts/build-voice-helper.mjs"), `${process.platform}-${process.arch}`, output], { encoding: "utf8", env });
    expect(result.status, result.stderr).toBe(0);
    const configure = JSON.parse(readFileSync(log, "utf8").split("\n")[0]);
    expect(configure.includes(`-DAGAV_VOICE_METAL=${metal}`)).toBe(metal !== undefined);
    expect(readFileSync(join(output, `agav-voice-${process.platform}-${process.arch}`), "utf8")).toContain("self-test passed");
    expect(result.stdout).toMatch(/\d+ bytes; self-test \d+ ms/);
  });
  it.each([[], ["wrong", "/tmp/unused"]])("rejects invalid helper arguments: %j", (...args) => {
    const result = spawnSync(process.execPath, ["scripts/build-voice-helper.mjs", ...args], { encoding: "utf8" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Usage:");
  });
  it("refuses a non-native helper target", () => {
    const target = process.platform === "win32" ? "linux-arm64" : "win32-x64";
    const result = spawnSync(process.execPath, ["scripts/build-voice-helper.mjs", target, "/tmp/unused"], { encoding: "utf8" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("native runner");
  });
  it.each(["wrong", "../linux-x64"])("rejects wrapper target %s before any compilation", target => {
    const result = spawnSync("bash", ["scripts/build-binary.sh", target], { encoding: "utf8" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(target === "all" ? "AGAV_VOICE_HELPER_PATH" : "Unsupported binary target");
  });
  it("requires an explicit matching prebuilt helper for cross builds", () => {
    const f = fixture();
    const target = process.platform === "win32" ? "linux-arm64" : "windows-x64";
    const result = f.run([target, "--voice"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("requires AGAV_VOICE_HELPER_PATH");
  });
  it("builds without voice by default even when CMake/prebuilt helpers are unavailable", () => {
    const f = fixture();
    const result = f.run([], { FAIL_NATIVE: "1", FAIL_EMBED: "1", AGAV_VOICE_HELPER_PATH: "/missing/helper" });
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(join(f.root, "compiled-bundle"), "utf8")).toBe("original stub\n");
  });
  it("cross-builds without voice without requiring a prebuilt helper", () => {
    const f = fixture(); const result = f.run(["linux-arm64"], { FAIL_NATIVE: "1" });
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(join(f.root, "compiled-bundle"), "utf8")).toBe("original stub\n");
  });
  it("requires all target helpers up front rather than omitting features", () => {
    const f = fixture();
    const result = f.run(["all"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("AGAV_VOICE_HELPER_DIR");
    expect(() => readFileSync(join(f.root, "compiled-bundle"))).toThrow();
  });
  it("builds every target with all features using target-specific helpers", () => {
    const f = fixture();
    const helpers = join(f.root, "helpers"); mkdirSync(helpers);
    for (const target of ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64", "win32-x64"]) {
      copyFileSync(f.helper, join(helpers, `agav-voice-${target}${target.startsWith("win32") ? ".exe" : ""}`));
    }
    const result = f.run(["all"], { AGAV_VOICE_HELPER_DIR: helpers, FAIL_NATIVE: "1" });
    expect(result.status, result.stderr).toBe(0);
    for (const target of ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64", "windows-x64", "windows-x64-baseline"]) {
      const expected = target.startsWith("windows") ? "win32-x64" : target;
      const file = join(f.root, "dist", `agav-${target}${target.startsWith("windows") ? ".exe" : ""}`);
      expect(readFileSync(file, "utf8")).toBe(`embedded ${expected}`);
    }
  });
  it("enables every feature for a single target with --all-features", () => {
    const f = fixture();
    const result = f.run(["native", "--all-features"], { AGAV_VOICE_HELPER_PATH: f.helper });
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(join(f.root, "compiled-bundle"), "utf8")).toContain("embedded ");
  });
  it("accepts the explicit voice flag before the target", () => {
    const f = fixture();
    const result = f.run(["--voice", "native"], { AGAV_VOICE_HELPER_PATH: f.helper });
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(join(f.root, "compiled-bundle"), "utf8")).toContain("embedded ");
  });
  it("builds native helpers automatically and restores the developer stub", () => {
    const f = fixture();
    const result = f.run(["native", "--voice"]);
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(join(f.root, "compiled-bundle"), "utf8")).toBe(`embedded ${process.platform}-${process.arch}`);
    expect(readFileSync(join(f.root, "source/voice/bundled-runtime.ts"), "utf8")).toBe("original stub\n");
  });
  it("uses native prebuilt helpers without invoking the native toolchain", () => {
    const f = fixture();
    const result = f.run(["native", "--voice"], { AGAV_VOICE_HELPER_PATH: f.helper, FAIL_NATIVE: "1" });
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(join(f.root, "compiled-bundle"), "utf8")).toContain("embedded ");
  });
  it("resolves relative prebuilt helper paths before protocol checks", () => {
    const f = fixture();
    const result = f.run(["native", "--voice"], { AGAV_VOICE_HELPER_PATH: "prebuilt" });
    expect(result.status, result.stderr).toBe(0);
  });
  it.each(["missing", "embed", "protocol", "native", "bun"])("fails closed and restores source on %s failure", kind => {
    const f = fixture();
    const env: NodeJS.ProcessEnv = kind === "native" ? { FAIL_NATIVE: "1" } : { AGAV_VOICE_HELPER_PATH: f.helper };
    if (kind === "missing") env.AGAV_VOICE_HELPER_PATH = join(f.root, "missing");
    if (kind === "embed") env.FAIL_EMBED = "1";
    if (kind === "protocol") env.HELPER_PROTOCOL = "2";
    if (kind === "bun") env.FAIL_BUN = "7";
    const result = f.run(["native", "--voice"], env);
    expect(result.status).not.toBe(0);
    expect(readFileSync(join(f.root, "source/voice/bundled-runtime.ts"), "utf8")).toBe("original stub\n");
    if (kind === "protocol") expect(result.stderr).toContain("--protocol-version 1");
    if (kind !== "bun") expect(() => readFileSync(join(f.root, "compiled-bundle"))).toThrow();
  });
  it("maps both Windows variants to win32-x64 helpers for cross builds", () => {
    const f = fixture();
    for (const target of ["windows-x64", "windows-x64-baseline"]) {
      const result = f.run([target, "--voice"], { AGAV_VOICE_HELPER_PATH: f.helper });
      expect(result.status, result.stderr).toBe(0);
      expect(readFileSync(join(f.root, "compiled-bundle"), "utf8")).toBe("embedded win32-x64");
      expect(readFileSync(join(f.root, "bun-args"), "utf8")).toContain(`dist/agav-${target}.exe`);
    }
  });
});
