import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { checkRead, checkWrite, formatWorkspaceWarning } from "../utils/workspace-guard.js";

describe("utils/workspace-guard (posix fs)", () => {
  let base: string;
  let project: string;
  let outside: string;

  beforeEach(async () => {
    base = await realpath(await mkdtemp(path.join(tmpdir(), "agav-workspace-guard-")));
    project = path.join(base, "project");
    outside = path.join(base, "outside");
    await mkdir(path.join(project, "src"), { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(path.join(project, "src", "index.ts"), "x");
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it("treats existing files, relative paths and the root itself as inside", async () => {
    expect(await checkWrite(path.join(project, "src", "index.ts"), project)).toEqual({
      inside: true, resolved: path.join(project, "src", "index.ts"),
    });
    expect((await checkWrite("src/index.ts", project)).inside).toBe(true);
    expect((await checkWrite(project, project)).inside).toBe(true);
    expect((await checkRead("src/index.ts", project)).inside).toBe(true);
  });

  it("re-appends a non-existent nested tail under the realpath of the longest existing prefix", async () => {
    const result = await checkWrite(path.join(project, "new", "deep", "file.ts"), project);
    expect(result).toEqual({ inside: true, resolved: path.join(project, "new", "deep", "file.ts") });
  });

  it("flags `..` traversal out of the project", async () => {
    const result = await checkWrite("src/../../outside/evil.ts", project);
    expect(result.inside).toBe(false);
    expect(result.resolved).toBe(path.join(outside, "evil.ts"));
    expect(result.reason).toBe("outside project root");
  });

  it("keeps `..` that stays inside the project inside", async () => {
    expect((await checkWrite("src/../other/file.ts", project)).inside).toBe(true);
  });

  it("does not treat a sibling with a shared name prefix as inside", async () => {
    await mkdir(`${project}-sibling`);
    expect((await checkWrite(`${project}-sibling/file.ts`, project)).inside).toBe(false);
  });

  it.skipIf(process.platform === "win32")("detects a symlinked directory escaping the project, even for a new file below it", async () => {
    await symlink(outside, path.join(project, "link"));
    const result = await checkWrite(path.join(project, "link", "sub", "new.ts"), project);
    expect(result.inside).toBe(false);
    expect(result.resolved).toBe(path.join(outside, "sub", "new.ts"));
  });

  it.skipIf(process.platform === "win32")("resolves a symlinked project root before comparing", async () => {
    const rootLink = path.join(base, "root-link");
    await symlink(project, rootLink);
    expect((await checkWrite(path.join(project, "src", "index.ts"), rootLink)).inside).toBe(true);
    expect((await checkWrite(path.join(rootLink, "src", "new.ts"), project)).inside).toBe(true);
  });

  it.skipIf(process.platform === "win32")("follows a dangling symlink whose target is outside the project", async () => {
    await symlink(path.join(outside, "new"), path.join(project, "x"));
    const direct = await checkWrite(path.join(project, "x"), project);
    expect(direct).toMatchObject({ inside: false, resolved: path.join(outside, "new"), reason: "outside project root" });
    // As an intermediate component too.
    const nested = await checkWrite(path.join(project, "x", "deep", "f.ts"), project);
    expect(nested).toMatchObject({ inside: false, resolved: path.join(outside, "new", "deep", "f.ts") });
  });

  it.skipIf(process.platform === "win32")("keeps a dangling symlink whose (relative) target is inside the project inside", async () => {
    await symlink("new", path.join(project, "x"));
    expect(await checkWrite(path.join(project, "x"), project)).toEqual({ inside: true, resolved: path.join(project, "new") });
    await symlink(path.join(project, "src", "later"), path.join(project, "src", "y"));
    expect(await checkWrite("src/y/a.ts", project)).toEqual({ inside: true, resolved: path.join(project, "src", "later", "a.ts") });
  });

  it.skipIf(process.platform === "win32")("follows chained dangling symlinks, resolving each relative to its own directory", async () => {
    await mkdir(path.join(project, "hop"));
    await symlink(path.join(project, "hop", "b"), path.join(project, "a"));
    await symlink("../../outside/final", path.join(project, "hop", "b"));
    const result = await checkWrite(path.join(project, "a", "f.ts"), project);
    expect(result).toMatchObject({ inside: false, resolved: path.join(outside, "final", "f.ts") });

    await symlink("c", path.join(project, "hop", "d"));
    await symlink("../in-final", path.join(project, "hop", "c"));
    expect(await checkWrite(path.join(project, "hop", "d"), project)).toEqual({ inside: true, resolved: path.join(project, "in-final") });
  });

  it.skipIf(process.platform === "win32")("treats a symlink loop as unsafe", async () => {
    await symlink(path.join(project, "loop2"), path.join(project, "loop1"));
    await symlink(path.join(project, "loop1"), path.join(project, "loop2"));
    const result = await checkWrite(path.join(project, "loop1", "f.ts"), project);
    expect(result.inside).toBe(false);
    expect(result.reason).toBe("too many symbolic links");
    await symlink("self", path.join(project, "self"));
    expect(await checkWrite(path.join(project, "self"), project)).toMatchObject({ inside: false, reason: "too many symbolic links" });
  });

  it("compares case-insensitively only when asked", async () => {
    const upper = project.toUpperCase();
    const fakeRealpath = async (p: string) => { throw Object.assign(new Error(p), { code: "ENOENT" }); };
    expect((await checkWrite(path.join(upper, "a.ts"), project, { realpath: fakeRealpath, caseInsensitive: true })).inside).toBe(true);
    expect((await checkWrite(path.join(upper, "a.ts"), project, { realpath: fakeRealpath, caseInsensitive: false })).inside).toBe(false);
  });

  it("formats a warning only for outside targets", async () => {
    expect(formatWorkspaceWarning({ inside: true, resolved: "/p/a" })).toBeUndefined();
    expect(formatWorkspaceWarning({ inside: false, resolved: "/x/a", reason: "outside project root" }))
      .toBe("Target is outside the project: /x/a");
    expect(formatWorkspaceWarning({ inside: false, resolved: "C:\\p\\a:s", reason: "NTFS alternate data stream" }))
      .toBe("Target is outside the project: C:\\p\\a:s (NTFS alternate data stream)");
  });
});

describe("utils/workspace-guard (win32 via path.win32 injection)", () => {
  const win = path.win32;

  /**
   * Fake Windows realpath: `links` maps canonical-lowercase existing paths to
   * their target (junctions, 8.3 short names); `existing` lists paths that
   * exist as-is. Anything else rejects with ENOENT, like fs.realpath.
   */
  function fakeFs(existing: string[], links: Record<string, string> = {}) {
    const exists = new Set(existing.map((p) => p.toLowerCase()));
    const linkMap = new Map(Object.entries(links).map(([k, v]) => [k.toLowerCase(), v]));
    return async (p: string): Promise<string> => {
      const key = win.resolve(p).toLowerCase();
      // Resolve the longest linked ancestor so children of junctions follow the link.
      for (const [from, to] of linkMap) {
        if (key === from || key.startsWith(`${from}\\`)) {
          const rest = win.resolve(p).slice(from.length);
          const candidate = to + rest;
          if (exists.has(candidate.toLowerCase()) || key === from) return candidate;
        }
      }
      if (exists.has(key)) return win.resolve(p);
      throw Object.assign(new Error(`ENOENT: ${p}`), { code: "ENOENT" });
    };
  }

  const root = "C:\\work\\project";
  const opts = (realpath: (p: string) => Promise<string>) => ({ path: win, realpath });
  const baseFs = fakeFs(["C:\\", "C:\\work", root, `${root}\\src`, "C:\\Users", "C:\\Users\\me"]);

  it("treats nested, new and differently-cased paths as inside", async () => {
    expect(await checkWrite(`${root}\\src\\new\\file.ts`, root, opts(baseFs)))
      .toEqual({ inside: true, resolved: `${root}\\src\\new\\file.ts` });
    expect((await checkWrite("C:\\WORK\\Project\\src\\a.ts", root, opts(baseFs))).inside).toBe(true);
    expect((await checkWrite("src/a.ts", root, opts(baseFs))).inside).toBe(true);
  });

  it("flags `..` traversal and other drives", async () => {
    const dotdot = await checkWrite("src\\..\\..\\..\\Users\\me\\x.txt", root, opts(baseFs));
    expect(dotdot).toMatchObject({ inside: false, resolved: "C:\\Users\\me\\x.txt", reason: "outside project root" });
    expect((await checkWrite("D:\\work\\project\\a.ts", root, opts(baseFs))).inside).toBe(false);
  });

  it("follows a junction inside the project that points outside", async () => {
    const realpath = fakeFs(
      ["C:\\", "C:\\work", root, "C:\\Users\\me\\secrets"],
      { [`${root}\\jn`]: "C:\\Users\\me\\secrets" },
    );
    const result = await checkWrite(`${root}\\jn\\new.txt`, root, opts(realpath));
    expect(result).toMatchObject({ inside: false, resolved: "C:\\Users\\me\\secrets\\new.txt" });
  });

  it("expands 8.3 short names via realpath on both target and root", async () => {
    const realpath = fakeFs(
      ["C:\\", "C:\\Program Files", "C:\\Program Files\\App"],
      { "C:\\PROGRA~1": "C:\\Program Files" },
    );
    expect((await checkWrite("C:\\PROGRA~1\\App\\cfg.ini", "C:\\Program Files\\App", opts(realpath))).inside).toBe(true);
    expect((await checkWrite("C:\\Program Files\\App\\new\\cfg.ini", "C:\\PROGRA~1\\App", opts(realpath))).inside).toBe(true);
  });

  it("unwraps \\\\?\\ and \\\\.\\ drive prefixes and the realpath's own \\\\?\\ output", async () => {
    expect((await checkWrite(`\\\\?\\${root}\\src\\a.ts`, root, opts(baseFs))).inside).toBe(true);
    expect((await checkWrite(`\\\\.\\${root}\\src\\a.ts`, root, opts(baseFs))).inside).toBe(true);
    const longFormFs = async (p: string) => `\\\\?\\${await baseFs(p)}`;
    expect((await checkWrite(`${root}\\src\\a.ts`, root, opts(longFormFs))).inside).toBe(true);
    expect((await checkWrite(`\\\\?\\C:\\Users\\me\\a.ts`, root, opts(baseFs))).inside).toBe(false);
  });

  it("rejects device namespace paths that are not drive or UNC paths", async () => {
    for (const p of ["\\\\.\\pipe\\agav", "\\\\?\\Volume{1234}\\a.txt", "\\\\?\\GLOBALROOT\\Device\\x", "\\\\.\\PhysicalDrive0"]) {
      const result = await checkWrite(p, root, opts(baseFs));
      expect(result).toMatchObject({ inside: false, reason: "device namespace path" });
    }
  });

  it("rejects UNC targets (including \\\\?\\UNC\\) when the project is on a local drive", async () => {
    for (const p of ["\\\\server\\share\\file.txt", "\\\\?\\UNC\\server\\share\\file.txt", "//server/share/file.txt"]) {
      const result = await checkWrite(p, root, opts(baseFs));
      expect(result).toMatchObject({ inside: false, resolved: "\\\\server\\share\\file.txt", reason: "UNC network path" });
    }
  });

  it("allows UNC targets inside a UNC project root", async () => {
    const uncRoot = "\\\\server\\share\\proj";
    const realpath = fakeFs(["\\\\server\\share\\", uncRoot]);
    expect((await checkWrite(`${uncRoot}\\a.txt`, uncRoot, opts(realpath))).inside).toBe(true);
    expect((await checkWrite("\\\\server\\share\\other\\a.txt", uncRoot, opts(realpath))).inside).toBe(false);
  });

  it("rejects NTFS alternate data streams even inside the project", async () => {
    for (const p of [`${root}\\src\\a.ts:hidden`, `${root}\\src\\a.ts::$DATA`, "src\\a.ts:zone.identifier"]) {
      const result = await checkWrite(p, root, opts(baseFs));
      expect(result).toMatchObject({ inside: false, reason: "NTFS alternate data stream" });
    }
  });

  it("follows dangling symlinks through injected lstat/readlink", async () => {
    const linkText: Record<string, string> = {
      [`${root}\\out`.toLowerCase()]: "C:\\Users\\me\\new",
      [`${root}\\in`.toLowerCase()]: "fresh",
      [`${root}\\src\\chain`.toLowerCase()]: "..\\in",
      [`${root}\\loop`.toLowerCase()]: `${root}\\loop`,
    };
    const lstat = async (p: string) => {
      const isLink = win.resolve(p).toLowerCase() in linkText;
      return { isSymbolicLink: () => isLink };
    };
    const readlink = async (p: string) => {
      const t = linkText[win.resolve(p).toLowerCase()];
      if (t === undefined) throw Object.assign(new Error(`EINVAL: ${p}`), { code: "EINVAL" });
      return t;
    };
    const o = { path: win, realpath: baseFs, lstat, readlink };
    expect(await checkWrite(`${root}\\out\\a.txt`, root, o))
      .toMatchObject({ inside: false, resolved: "C:\\Users\\me\\new\\a.txt" });
    expect(await checkWrite(`${root}\\in`, root, o)).toEqual({ inside: true, resolved: `${root}\\fresh` });
    expect(await checkWrite(`${root}\\src\\chain\\a.txt`, root, o)).toEqual({ inside: true, resolved: `${root}\\fresh\\a.txt` });
    expect(await checkWrite(`${root}\\loop`, root, o)).toMatchObject({ inside: false, reason: "too many symbolic links" });
    // Without injected link ops, an injected realpath keeps the previous (lexical-tail) behaviour.
    expect((await checkWrite(`${root}\\out\\a.txt`, root, opts(baseFs))).inside).toBe(true);
  });

  it("rejects reserved device names inside the project", async () => {
    for (const p of [`${root}\\NUL`, `${root}\\src\\con.txt`, `${root}\\COM1 .log`]) {
      const result = await checkWrite(p, root, opts(baseFs));
      expect(result).toMatchObject({ inside: false, reason: "reserved device name" });
    }
    expect((await checkWrite(`${root}\\src\\console.ts`, root, opts(baseFs))).inside).toBe(true);
  });
});
