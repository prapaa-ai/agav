import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prepareSandboxWorkspace } from "../utils/sandbox-workspace.js";

let root: string;
let host: string;
const workspaces: ReturnType<typeof prepareSandboxWorkspace>[] = [];
function prepare() {
	const workspace = prepareSandboxWorkspace(host);
	workspaces.push(workspace);
	return workspace;
}
function write(base: string, name: string, value = name) {
	fs.mkdirSync(dirname(join(base, name)), { recursive: true });
	fs.writeFileSync(join(base, name), value);
}
function read(base: string, name: string) { return fs.readFileSync(join(base, name), "utf8"); }

beforeEach(() => {
	root = fs.mkdtempSync(join(tmpdir(), "agav-workspace-test-"));
	host = join(root, "host");
	fs.mkdirSync(host);
});
afterEach(() => {
	vi.restoreAllMocks();
	for (const workspace of workspaces.splice(0)) workspace.cleanup();
	fs.rmSync(root, { recursive: true, force: true });
});

describe("sandbox workspace snapshot and publication", () => {
	it("copies bytes and modes privately, with no host placeholders or shared hardlinks", () => {
		write(host, "run", "before");
		fs.chmodSync(join(host, "run"), 0o755);
		fs.linkSync(join(host, "run"), join(host, "hardlink"));
		fs.symlinkSync("run", join(host, "link"));
		const workspace = prepare();
		expect(fs.statSync(dirname(workspace.path)).mode & 0o777).toBe(0o700);
		expect(fs.readdirSync(dirname(workspace.path))).toEqual(["workspace"]);
		expect(fs.statSync(join(workspace.path, "run")).mode & 0o777).toBe(0o755);
		expect(fs.statSync(join(workspace.path, "run")).ino).not.toBe(fs.statSync(join(host, "run")).ino);
		expect(fs.statSync(join(workspace.path, "hardlink")).nlink).toBe(1);
		expect(fs.readlinkSync(join(workspace.path, "link"))).toBe("run");
		write(workspace.path, "run", "private");
		expect(read(host, "run")).toBe("before");
		expect(fs.readdirSync(host).sort()).toEqual(["hardlink", "link", "run"]);
	});

	it("publishes create/edit/delete, directory renames, empty dirs, modes, and type replacements", () => {
		write(host, "edit", "before");
		write(host, "delete");
		write(host, "old/child", "moved");
		write(host, "file-to-dir");
		write(host, "dir-to-file/child");
		fs.symlinkSync("edit", join(host, "unchanged-link"));
		const workspace = prepare();
		write(workspace.path, "edit", "after");
		fs.chmodSync(join(workspace.path, "edit"), 0o751);
		fs.unlinkSync(join(workspace.path, "delete"));
		fs.renameSync(join(workspace.path, "old"), join(workspace.path, "renamed"));
		fs.unlinkSync(join(workspace.path, "file-to-dir"));
		write(workspace.path, "file-to-dir/new", "new");
		fs.rmSync(join(workspace.path, "dir-to-file"), { recursive: true });
		write(workspace.path, "dir-to-file", "file now");
		fs.mkdirSync(join(workspace.path, "empty"));
		workspace.publish();
		expect(read(host, "edit")).toBe("after");
		expect(fs.statSync(join(host, "edit")).mode & 0o777).toBe(0o751);
		expect(fs.existsSync(join(host, "delete"))).toBe(false);
		expect(fs.existsSync(join(host, "old"))).toBe(false);
		expect(read(host, "renamed/child")).toBe("moved");
		expect(read(host, "file-to-dir/new")).toBe("new");
		expect(read(host, "dir-to-file")).toBe("file now");
		expect(fs.readdirSync(join(host, "empty"))).toEqual([]);
		expect(fs.readlinkSync(join(host, "unchanged-link"))).toBe("edit");
		expect(() => workspace.publish()).toThrow(/already/);
		workspace.cleanup();
		workspace.cleanup();
		expect(fs.existsSync(workspace.path)).toBe(false);
	});

	it("publishes git status/add state from a normal repository without creating a commit", () => {
		const git = (cwd: string, ...args: string[]) => execFileSync("git", args, {
			cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_COUNT: "0" },
		});
		git(host, "init", "--quiet", "--initial-branch=main", "--template=");
		write(host, "file", "original");
		const config = read(host, ".git/config");
		const workspace = prepare();
		expect(git(workspace.path, "status", "--porcelain")).toBe("?? file\n");
		write(workspace.path, "file", "staged");
		git(workspace.path, "add", "file");
		workspace.publish();
		expect(git(host, "status", "--porcelain")).toBe("A  file\n");
		expect(git(host, "show", ":file")).toBe("staged");
		expect(read(host, ".git/config")).toBe(config);
		expect(fs.existsSync(join(host, ".git/refs/heads/main"))).toBe(false);
	});

	it.each(["index", "HEAD", "HEAD.lock", "ORIG_HEAD", "FETCH_HEAD", "MERGE_HEAD", "MERGE_MSG", "MERGE_MODE", "AUTO_MERGE", "COMMIT_EDITMSG", "packed-refs", "shallow", "refs/heads/main", "logs/HEAD", "objects/ab/cdef", "objects/pack/pack-test.pack"])("publishes ordinary Git state %s", name => {
		write(host, "nested/.git/HEAD", "original");
		const workspace = prepare();
		write(workspace.path, `nested/.git/${name}`, "updated");
		workspace.publish();
		expect(read(host, `nested/.git/${name}`)).toBe("updated");
	});

	it.each(["config", "config.worktree", "hooks/pre-commit", "commondir", "gitdir", "objects/info/alternates", "objects/info/http-alternates", "worktrees/other/gitdir", "unknown"])("rejects creation of nonordinary Git metadata %s", name => {
		write(host, ".git/HEAD", "original");
		const workspace = prepare();
		write(workspace.path, "allowed", "must not publish");
		write(workspace.path, `.git/${name}`, "blocked");
		expect(() => workspace.publish()).toThrow(/protected/);
		expect(fs.existsSync(join(host, "allowed"))).toBe(false);
		expect(fs.existsSync(join(host, ".git", name))).toBe(false);
	});

	it.each(["delete", "rename", "replace", "mode"])("rejects whole .git %s even when all its contents are ordinary state", operation => {
		write(host, ".git/HEAD", "original");
		const workspace = prepare();
		write(workspace.path, "allowed", "must not publish");
		if (operation === "delete") fs.rmSync(join(workspace.path, ".git"), { recursive: true });
		if (operation === "rename") fs.renameSync(join(workspace.path, ".git"), join(workspace.path, "renamed"));
		if (operation === "replace") {
			fs.renameSync(join(workspace.path, ".git"), join(workspace.path, "old"));
			write(workspace.path, ".git/HEAD", "original");
		}
		if (operation === "mode") fs.chmodSync(join(workspace.path, ".git"), 0o700);
		expect(() => workspace.publish()).toThrow(/protected/);
		expect(read(host, ".git/HEAD")).toBe("original");
		expect(fs.existsSync(join(host, "allowed"))).toBe(false);
	});

	it.each(["index/child", "HEAD/child", "refs", "logs", "objects"])("rejects invalid ordinary Git state type at %s", name => {
		write(host, ".git/config", "original");
		const workspace = prepare();
		write(workspace.path, `.git/${name}`, "blocked");
		expect(() => workspace.publish()).toThrow(/protected/);
	});

	it.each([false, true])("keeps a linked-worktree gitfile immutable (edited: %s)", edited => {
		write(host, ".git", "gitdir: ../external/worktrees/linked\n");
		const workspace = prepare();
		write(workspace.path, "file", "ordinary");
		if (edited) {
			write(workspace.path, ".git", "gitdir: ../elsewhere\n");
			expect(() => workspace.publish()).toThrow(/protected/);
			expect(fs.existsSync(join(host, "file"))).toBe(false);
		} else {
			workspace.publish();
			expect(read(host, "file")).toBe("ordinary");
		}
		expect(read(host, ".git")).toBe("gitdir: ../external/worktrees/linked\n");
	});

	it("rejects creating an absent .git directory containing only ordinary state", () => {
		const workspace = prepare();
		write(workspace.path, ".git/HEAD", "ref: refs/heads/main\n");
		expect(() => workspace.publish()).toThrow(/protected/);
		expect(fs.readdirSync(host)).toEqual([]);
	});

	it("publishes deletion and rename of ordinary Git state without removing .git", () => {
		write(host, ".git/index.lock", "old lock");
		write(host, ".git/refs/heads/old", "ref");
		const workspace = prepare();
		fs.unlinkSync(join(workspace.path, ".git/index.lock"));
		fs.renameSync(join(workspace.path, ".git/refs/heads/old"), join(workspace.path, ".git/refs/heads/new"));
		workspace.publish();
		expect(fs.existsSync(join(host, ".git/index.lock"))).toBe(false);
		expect(fs.existsSync(join(host, ".git/refs/heads/old"))).toBe(false);
		expect(read(host, ".git/refs/heads/new")).toBe("ref");
	});

	it.each(["symlink", "hardlink"])("retains baseline %s alias protection for ordinary Git state", kind => {
		write(host, ".git/index", "original");
		if (kind === "symlink") fs.symlinkSync("index", join(host, ".git/config"));
		else fs.linkSync(join(host, ".git/index"), join(host, ".git/config"));
		const workspace = prepare();
		write(workspace.path, ".git/index", "changed");
		expect(() => workspace.publish()).toThrow(/protected|hardlink/);
		expect(read(host, ".git/index")).toBe("original");
	});

	it.each(["add symlink", "replace symlink", "hardlink"])("rejects ordinary Git state link output: %s", kind => {
		write(host, ".git/HEAD", "original");
		if (kind === "replace symlink") fs.symlinkSync("HEAD", join(host, ".git/index"));
		const workspace = prepare();
		if (kind === "replace symlink") fs.renameSync(join(workspace.path, ".git/index"), join(workspace.path, "moved-link"));
		if (kind === "hardlink") fs.linkSync(join(workspace.path, ".git/HEAD"), join(workspace.path, ".git/index"));
		else fs.symlinkSync("HEAD", join(workspace.path, ".git/index"));
		expect(() => workspace.publish()).toThrow(/protected|symlink|hardlink/);
		expect(read(host, ".git/HEAD")).toBe("original");
	});

	it("rejects aliases added to Git config on the host after preparation", () => {
		write(host, ".git/index", "original");
		const workspace = prepare();
		write(workspace.path, ".git/index", "changed");
		fs.symlinkSync("index", join(host, ".git/config"));
		expect(() => workspace.publish()).toThrow(/protected alias conflict/);
		expect(read(host, ".git/index")).toBe("original");
	});

	it.each([".git", ".agav", ".vscode", ".idea", ".bashrc", ".bash_profile", ".profile", ".zshrc", ".zprofile", ".envrc"])("rejects newly created protected %s at any depth before publishing anything", name => {
		const workspace = prepare();
		write(workspace.path, "allowed", "must not publish");
		write(workspace.path, `nested/${name}`, "blocked");
		expect(() => workspace.publish()).toThrow(/protected/);
		expect(fs.readdirSync(host)).toEqual([]);
	});

	it.each(["edit", "delete", "rename", "mode"])("rejects protected %s, including removed ancestor directories", operation => {
		write(host, "parent/.git/config", "original");
		const workspace = prepare();
		write(workspace.path, "ordinary", "must not publish");
		if (operation === "edit") write(workspace.path, "parent/.git/config", "changed");
		if (operation === "delete") fs.rmSync(join(workspace.path, "parent"), { recursive: true });
		if (operation === "rename") fs.renameSync(join(workspace.path, "parent"), join(workspace.path, "renamed"));
		if (operation === "mode") fs.chmodSync(join(workspace.path, "parent/.git/config"), 0o700);
		expect(() => workspace.publish()).toThrow(/protected/);
		expect(read(host, "parent/.git/config")).toBe("original");
		expect(fs.existsSync(join(host, "ordinary"))).toBe(false);
	});

	it.each(["relative", "absolute", "chained", "dangling"])("rejects writes to %s targets aliased by protected symlinks", kind => {
		if (kind !== "dangling") write(host, "ordinary/config", "original");
		if (kind === "chained") fs.symlinkSync("ordinary", join(host, "alias"));
		fs.symlinkSync(kind === "absolute" ? join(host, "ordinary") : kind === "chained" ? "alias" : "ordinary", join(host, ".git"));
		const workspace = prepare();
		write(workspace.path, "ordinary/config", "changed");
		expect(() => workspace.publish()).toThrow(/protected/);
		expect(fs.existsSync(join(host, "ordinary/config"))).toBe(kind !== "dangling");
	});

	it.each(["add", "replace", "remove", "alias", "hardlink"])("rejects %s link output while preserving unchanged symlinks", kind => {
		write(host, ".agav/config", "protected");
		write(host, "normal", "original");
		fs.symlinkSync("normal", join(host, "link"));
		const workspace = prepare();
		write(workspace.path, "allowed", "not published");
		if (kind === "add") fs.symlinkSync("normal", join(workspace.path, "new-link"));
		if (kind === "replace") { fs.unlinkSync(join(workspace.path, "link")); write(workspace.path, "link", "replacement"); }
		if (kind === "remove") fs.unlinkSync(join(workspace.path, "link"));
		if (kind === "alias") fs.symlinkSync(".agav/config", join(workspace.path, "new-link"));
		if (kind === "hardlink") fs.linkSync(join(workspace.path, "normal"), join(workspace.path, "new-link"));
		expect(() => workspace.publish()).toThrow(/symlink|hardlink/);
		expect(fs.existsSync(join(host, "allowed"))).toBe(false);
		expect(read(host, ".agav/config")).toBe("protected");
	});

	it("rejects editing a host hardlink alias to protected data", () => {
		write(host, ".bashrc", "original");
		fs.linkSync(join(host, ".bashrc"), join(host, "alias"));
		const workspace = prepare();
		write(workspace.path, "alias", "changed");
		expect(() => workspace.publish()).toThrow(/hardlink/);
		expect(read(host, ".bashrc")).toBe("original");
	});

	it.each(["content", "mode", "missing", "created", "parent inode", "parent symlink", "new descendant"])("preflights the whole batch for host %s conflicts", kind => {
		write(host, "parent/file", "original");
		const workspace = prepare();
		write(workspace.path, "aaa", "must not publish");
		write(workspace.path, "parent/file", "sandbox");
		if (kind === "content") write(host, "parent/file", "external");
		if (kind === "mode") fs.chmodSync(join(host, "parent/file"), 0o700);
		if (kind === "missing") fs.unlinkSync(join(host, "parent/file"));
		if (kind === "created") { write(workspace.path, "new", "sandbox"); write(host, "new", "external"); }
		if (kind === "parent inode" || kind === "parent symlink") {
			fs.renameSync(join(host, "parent"), join(host, "moved"));
			if (kind === "parent symlink") fs.symlinkSync("moved", join(host, "parent"));
			else write(host, "parent/file", "original");
		}
		if (kind === "new descendant") { fs.rmSync(join(workspace.path, "parent"), { recursive: true }); write(host, "parent/new", "external"); }
		expect(() => workspace.publish()).toThrow(/conflict/);
		expect(fs.existsSync(join(host, "aaa"))).toBe(false);
	});

	it("rejects protected aliases added on the host after preparation", () => {
		write(host, "config", "original");
		const workspace = prepare();
		write(workspace.path, "config", "sandbox");
		fs.symlinkSync("config", join(host, ".bashrc"));
		expect(() => workspace.publish()).toThrow(/protected alias conflict/);
		expect(read(host, "config")).toBe("original");
	});

	it("rejects an unchanged hardlinked output inode", () => {
		write(host, "file", "original");
		const workspace = prepare();
		fs.linkSync(join(workspace.path, "file"), join(root, "external-link"));
		expect(() => workspace.publish()).toThrow(/hardlink/);
		expect(read(host, "file")).toBe("original");
	});

	it("bounds output directory depth", () => {
		const workspace = prepare();
		fs.mkdirSync(join(workspace.path, ...Array.from({ length: 129 }, () => "d")), { recursive: true });
		expect(() => workspace.publish()).toThrow(/depth limit/);
		expect(fs.readdirSync(host)).toEqual([]);
	});

	it("allows unrelated host changes without copying them over", () => {
		write(host, "file", "original");
		const workspace = prepare();
		write(workspace.path, "file", "sandbox");
		write(host, "unrelated", "external");
		workspace.publish();
		expect(read(host, "unrelated")).toBe("external");
	});

	it.each(["symlink", "directory"])("rejects a replaced snapshot root (%s), and cleans up without following links", kind => {
		write(host, "safe", "original");
		const workspace = prepare();
		fs.rmSync(workspace.path, { recursive: true });
		if (kind === "symlink") fs.symlinkSync(host, workspace.path);
		else fs.mkdirSync(workspace.path);
		expect(() => workspace.publish()).toThrow();
		workspace.cleanup();
		expect(read(host, "safe")).toBe("original");
	});

	it("rejects special files in both input and output without blocking on a FIFO", () => {
		execFileSync("mkfifo", [join(host, "pipe")]);
		expect(() => prepare()).toThrow(/special files/);
		fs.unlinkSync(join(host, "pipe"));
		const workspace = prepare();
		execFileSync("mkfifo", [join(workspace.path, "pipe")]);
		expect(() => workspace.publish()).toThrow(/special files/);
		expect(fs.readdirSync(host)).toEqual([]);
	});

	it("rejects oversized sparse output before allocating its payload", () => {
		const workspace = prepare();
		write(workspace.path, "huge", "");
		fs.truncateSync(join(workspace.path, "huge"), 256 * 1024 * 1024 + 1);
		expect(() => workspace.publish()).toThrow(/limit/);
		expect(fs.readdirSync(host)).toEqual([]);
	});

	it("detects output mutation during staging before touching host files", () => {
		write(host, "file", "original");
		const workspace = prepare();
		write(workspace.path, "file", "output");
		const originalRead = fs.readSync;
		let changed = false;
		vi.spyOn(fs, "readSync").mockImplementation(((...args: Parameters<typeof fs.readSync>) => {
			const result = Reflect.apply(originalRead, fs, args);
			if (!changed) { changed = true; write(workspace.path, "file", "racing writer"); }
			return result;
		}) as typeof fs.readSync);
		expect(() => workspace.publish()).toThrow(/changed/);
		expect(read(host, "file")).toBe("original");
	});

	it.each([false, true])("rolls back failures without overwriting observed concurrent edits (concurrent: %s)", concurrent => {
		write(host, "a", "original a");
		write(host, "b", "original b");
		const workspace = prepare();
		write(workspace.path, "a", "output a");
		write(workspace.path, "b", "output b");
		const rename = fs.renameSync;
		let calls = 0;
		vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
			if (++calls === 2) {
				if (concurrent) write(host, "a", "external");
				throw new Error("injected rename failure");
			}
			rename(from, to);
		});
		expect(() => workspace.publish()).toThrow(concurrent ? /rollback incomplete/ : /injected/);
		expect(read(host, "a")).toBe(concurrent ? "external" : "original a");
		expect(read(host, "b")).toBe("original b");
		expect(fs.readdirSync(host).sort()).toEqual(["a", "b"]);
	});
});

describe("publication path-resolution regressions", () => {
	it("resolves dot-dot after symlink traversal in a protected alias", () => {
		write(host, "real/deep/keep", "keep");
		write(host, "real/config", "original");
		fs.symlinkSync("real/deep", join(host, "alias"));
		fs.symlinkSync("alias/../config", join(host, ".envrc"));
		const workspace = prepare();
		write(workspace.path, "real/config", "injected");
		expect(() => workspace.publish()).toThrow(/protected/);
		expect(read(host, "real/config")).toBe("original");
	});

	it("refuses temporary storage nested inside the source before creating a snapshot", () => {
		const temp = join(host, "temp");
		fs.mkdirSync(temp);
		vi.stubEnv("TMPDIR", temp);
		vi.stubEnv("TMP", temp);
		vi.stubEnv("TEMP", temp);
		try {
			expect(() => prepare()).toThrow(/temporary storage must be outside/);
			expect(fs.readdirSync(temp)).toEqual([]);
		} finally { vi.unstubAllEnvs(); }
	});
});

describe("protected aliases through external directories", () => {
	it("does not publish through an off-workspace link back into the workspace", () => {
		write(host, "target", "original");
		fs.mkdirSync(join(root, "outside"));
		fs.symlinkSync(join(host, "target"), join(root, "outside", "link"));
		fs.symlinkSync(join(root, "outside", "link"), join(host, ".envrc"));
		const workspace = prepare();
		write(workspace.path, "target", "injected");
		expect(() => workspace.publish()).toThrow(/protected/);
		expect(read(host, "target")).toBe("original");
	});
});

describe("external Git metadata publication", () => {
	function linked() {
		write(root, "main/.git/config", "[core]\nrepositoryformatversion = 0\n");
		write(root, "main/.git/HEAD", "ref: refs/heads/main\n");
		write(root, "main/.git/worktrees/linked/HEAD", "ref: refs/heads/linked\n");
		write(root, "main/.git/worktrees/linked/commondir", "../..\n");
		write(host, ".git", `gitdir: ${join(root, "main/.git/worktrees/linked")}\n`);
		const workspace = prepareSandboxWorkspace(host, true);
		workspaces.push(workspace);
		return { workspace, common: join(root, "main/.git"), privateCommon: workspace.mounts[0]!.source };
	}
	it("publishes common objects and per-worktree index without exposing writable host binds", () => {
		const { workspace, common, privateCommon } = linked();
		expect(workspace.mounts).toHaveLength(1);
		expect(workspace.mounts[0]!.target).toBe(fs.realpathSync(common));
		write(workspace.path, "file", "staged");
		write(privateCommon, "worktrees/linked/index", "index");
		write(privateCommon, "objects/ab/cdef", "object");
		workspace.publish();
		expect(read(host, "file")).toBe("staged");
		expect(read(common, "worktrees/linked/index")).toBe("index");
		expect(read(common, "objects/ab/cdef")).toBe("object");
	});
	it.each(["config", "worktrees/linked/config.worktree", "hooks/pre-commit", "worktrees/other/index"])("rejects external %s before publishing workspace changes", name => {
		const { workspace, privateCommon } = linked();
		write(workspace.path, "ordinary", "must not publish");
		write(privateCommon, name, "bad");
		expect(() => workspace.publish()).toThrow(/protected/);
		expect(fs.existsSync(join(host, "ordinary"))).toBe(false);
	});
	it("preflights external conflicts before workspace publication", () => {
		const { workspace, common, privateCommon } = linked();
		write(workspace.path, "ordinary", "must not publish");
		write(privateCommon, "worktrees/linked/index", "sandbox");
		write(common, "worktrees/linked/index", "host edit");
		expect(() => workspace.publish()).toThrow(/conflict/);
		expect(fs.existsSync(join(host, "ordinary"))).toBe(false);
		expect(read(common, "worktrees/linked/index")).toBe("host edit");
	});
	it("rolls workspace changes back when later metadata publication fails", () => {
		const { workspace, privateCommon } = linked();
		write(workspace.path, "ordinary", "new file");
		write(privateCommon, "worktrees/linked/index", "index");
		const rename = fs.renameSync;
		let calls = 0;
		vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
			if (++calls === 2) throw new Error("metadata write failed");
			rename(from, to);
		});
		expect(() => workspace.publish()).toThrow(/metadata write failed/);
		expect(fs.existsSync(join(host, "ordinary"))).toBe(false);
	});
	it("supports separate-git-dir/submodule layouts with real git add", () => {
		const metadata = join(root, "external");
		const git = (...args: string[]) => execFileSync("git", args, { cwd: host, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_COUNT: "0" } });
		git("init", "--quiet", "--template=", "--separate-git-dir", metadata);
		write(host, "file", "original");
		const workspace = prepareSandboxWorkspace(host, true);
		workspaces.push(workspace);
		write(workspace.path, "file", "staged");
		execFileSync("git", ["--git-dir", workspace.mounts[0]!.source, "--work-tree", workspace.path, "add", "file"], { cwd: workspace.path });
		workspace.publish();
		expect(git("show", ":file")).toBe("staged");
	});
});

it("protects config aliases inside external Git metadata", () => {
	write(root, "external/HEAD", "ref: refs/heads/main\n");
	write(root, "external/index", "original");
	fs.symlinkSync("index", join(root, "external/config"));
	write(host, ".git", `gitdir: ${join(root, "external")}\n`);
	const workspace = prepareSandboxWorkspace(host, true);
	workspaces.push(workspace);
	write(workspace.mounts[0]!.source, "index", "injected");
	expect(() => workspace.publish()).toThrow(/protected/);
	expect(read(root, "external/index")).toBe("original");
});

it("stages with real Git against isolated linked-worktree common metadata", () => {
	const main = join(root, "main");
	fs.mkdirSync(main);
	const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_COUNT: "0" };
	execFileSync("git", ["init", "--quiet", "--template=", main], { env });
	const common = join(main, ".git");
	const metadata = join(common, "worktrees", "linked");
	write(metadata, "HEAD", "ref: refs/heads/linked\n");
	write(metadata, "commondir", "../..\n");
	write(metadata, "gitdir", join(host, ".git") + "\n");
	write(host, ".git", `gitdir: ${metadata}\n`);
	write(host, "file", "original");
	const workspace = prepareSandboxWorkspace(host, true);
	workspaces.push(workspace);
	const privateCommon = workspace.mounts[0]!.source;
	write(workspace.path, "file", "staged");
	execFileSync("git", ["--git-dir", join(privateCommon, "worktrees/linked"), "--work-tree", workspace.path, "add", "file"], { cwd: workspace.path, env });
	workspace.publish();
	expect(execFileSync("git", ["-C", host, "show", ":file"], { encoding: "utf8", env })).toBe("staged");
	expect(read(metadata, "commondir")).toBe("../..\n");
});
