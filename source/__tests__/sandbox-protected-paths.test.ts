import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { discoverSandboxProtectedPaths, resolveSandboxPath } from "../utils/sandbox-protected-paths.js";

vi.mock("node:child_process", () => ({ execFileSync: vi.fn(() => { throw new Error("Git must not run during discovery"); }) }));
let root: string;
let cwd: string;
function write(path: string, text: string) {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, text);
}
function paths() { return discoverSandboxProtectedPaths(cwd).protectedPaths; }
beforeEach(() => {
	root = realpathSync(mkdtempSync(join(tmpdir(), "agav-protected-")));
	cwd = join(root, "work");
	mkdirSync(cwd);
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); vi.clearAllMocks(); });

describe("sandbox protected path discovery", () => {
	it("reserves absent config/hooks names but leaves ordinary Git state writable", () => {
		const policy = discoverSandboxProtectedPaths(cwd);
		for (const name of ["config", "config.worktree", "commondir", "gitdir"]) {
			expect(policy.protectedPaths).toContainEqual({ path: join(cwd, ".git", name), kind: "file" });
		}
		expect(policy.protectedPaths).toContainEqual({ path: join(cwd, ".git/hooks"), kind: "directory" });
		expect(policy.protectedPaths).toContainEqual({ path: join(cwd, ".git"), kind: "file" });
		for (const name of ["HEAD", "HEAD.lock", "index", "index.lock", "config.lock", "objects", "refs"]) {
			expect(policy.protectedPaths.some(entry => entry.path === join(cwd, ".git", name) && entry.kind !== "ancestor")).toBe(false);
		}
	});

	it.each([false, true])("protects original names, chained links and targets (dangling: %s)", dangling => {
		if (!dangling) write(join(cwd, "ordinary/deep/config"), "original");
		symlinkSync("ordinary", join(cwd, "alias"));
		symlinkSync("alias/deep", join(cwd, ".agav"));
		const entries = paths();
		for (const name of [".agav", "alias"]) expect(entries).toContainEqual(expect.objectContaining({ path: join(cwd, name) }));
		expect(entries).toContainEqual({ path: join(cwd, "ordinary/deep"), kind: "directory" });
		expect(entries).toContainEqual({ path: join(cwd, "ordinary"), kind: "ancestor" });
		expect(entries).toContainEqual({ path: cwd, kind: "ancestor" });
	});

	it("resolves missing descendants through the nearest existing ancestor", () => {
		mkdirSync(join(root, "real"));
		symlinkSync(join(root, "real"), join(cwd, ".vscode"));
		expect(resolveSandboxPath(join(cwd, ".vscode/missing/deep/file")).path).toBe(join(root, "real/missing/deep/file"));
	});

	it("resolves dot-dot after symlinks rather than lexically before them", () => {
		mkdirSync(join(root, "real/deep"), { recursive: true });
		symlinkSync(join(root, "real/deep"), join(cwd, "alias"));
		symlinkSync("alias/../config", join(cwd, ".bashrc"));
		expect(paths()).toContainEqual({ path: join(root, "real/config"), kind: "file" });
	});

	it("protects linked-worktree pointers and common config without invoking Git", () => {
		const gitdir = join(root, "main/.git/worktrees/linked");
		write(join(cwd, ".git"), "gitdir: ../main/.git/worktrees/linked\n");
		write(join(gitdir, "commondir"), "../..\n");
		write(join(root, "main/.git/config"), "[core]\nfsmonitor = malicious\n");
		const policy = discoverSandboxProtectedPaths(cwd);
		expect(policy.protectedPaths).toContainEqual({ path: join(cwd, ".git"), kind: "file" });
		for (const dir of [gitdir, join(root, "main/.git")]) {
			expect(policy.protectedPaths).toContainEqual({ path: join(dir, "config"), kind: "file" });
			expect(policy.protectedPaths).toContainEqual({ path: join(dir, "config.worktree"), kind: "file" });
			expect(policy.protectedPaths).toContainEqual({ path: join(dir, "hooks"), kind: "directory" });
			expect(policy.gitWritablePaths).toContainEqual({ path: join(dir, "index.lock"), kind: "file" });
			expect(policy.gitWritablePaths).toContainEqual({ path: join(dir, "objects"), kind: "directory" });
			expect(policy.gitWritablePaths.some(entry => entry.path === dir)).toBe(false);
		}
		expect(execFileSync).not.toHaveBeenCalled();
	});

	it("discovers the enclosing repository when cwd is nested", () => {
		write(join(cwd, ".git/config"), "safe");
		const repository = cwd;
		cwd = join(cwd, "src/nested");
		mkdirSync(cwd, { recursive: true });
		expect(paths()).toContainEqual({ path: join(repository, ".git/config"), kind: "file" });
	});

	it("protects symlinked gitdir, commondir and config aliases", () => {
		const metadata = join(root, "metadata");
		write(join(metadata, "config"), "safe");
		symlinkSync(metadata, join(cwd, ".git"));
		write(join(root, "shared/config"), "safe");
		write(join(root, "pointer"), "../shared\n");
		symlinkSync(join(root, "pointer"), join(metadata, "commondir"));
		const entries = paths();
		for (const path of [join(cwd, ".git"), join(root, "pointer"), join(metadata, "commondir"), join(root, "shared/config")]) {
			expect(entries).toContainEqual({ path, kind: "file" });
		}
	});

	it.each([".agav", ".git", ".bashrc"])("fails closed on a symlink cycle at %s", name => {
		symlinkSync("loop", join(cwd, name));
		symlinkSync(name, join(cwd, "loop"));
		expect(() => paths()).toThrow(/cycle/);
	});

	it.each(["", "not gitdir", "gitdir: ", "gitdir: target\ninjected", "gitdir: target\0bad"])("rejects malformed gitfiles: %j", text => {
		write(join(cwd, ".git"), text);
		expect(() => paths()).toThrow(/Invalid Git/);
	});

	it("rejects cyclic and chained commondir metadata", () => {
		write(join(cwd, ".git/commondir"), ".\n");
		expect(() => paths()).toThrow(/Cyclic/);
		write(join(cwd, ".git/commondir"), "../../common\n");
		write(join(root, "common/commondir"), "../work/.git\n");
		expect(() => paths()).toThrow(/Chained/);
	});

	it("does not swallow unexpected filesystem errors", () => {
		write(join(cwd, "file"), "ordinary file");
		symlinkSync("file/child", join(cwd, ".agav"));
		expect(() => paths()).toThrow(/ENOTDIR/);
	});
});

it("fails closed for hardlinked protected files instead of permitting alias writes", async () => {
	const { linkSync } = await import("node:fs");
	write(join(cwd, ".envrc"), "protected");
	linkSync(join(cwd, ".envrc"), join(cwd, "ordinary"));
	expect(() => paths()).toThrow(/hardlink aliases/);
});

it("interprets a symlinked gitfile's relative gitdir from its original parent", () => {
	write(join(root, "pointers/gitfile"), "gitdir: metadata\n");
	write(join(cwd, "metadata/config"), "safe");
	symlinkSync(join(root, "pointers/gitfile"), join(cwd, ".git"));
	const policy = discoverSandboxProtectedPaths(cwd);
	expect(policy.gitDirectories).toContain(join(cwd, "metadata"));
	expect(policy.protectedPaths).toContainEqual({ path: join(cwd, "metadata/config"), kind: "file" });
});
