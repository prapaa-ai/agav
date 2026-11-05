import { discoverSandboxProtectedPaths, resolveSandboxPath, type SandboxProtectedPath } from "./sandbox-protected-paths.js";
import fs, { constants as C, type Stats } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";

const PROTECTED = new Set([
	".git", ".agav", ".vscode", ".idea", ".bashrc", ".bash_profile",
	".profile", ".zshrc", ".zprofile", ".envrc",
]);
// Match ordinary state exposed by sandbox-protected-paths, but never grant
// an entire metadata directory (config, hooks, and pointers stay immutable).
const GIT_STATE_FILES = new Set([
	"HEAD", "index", "ORIG_HEAD", "FETCH_HEAD", "MERGE_HEAD", "MERGE_MSG",
	"MERGE_MODE", "AUTO_MERGE", "COMMIT_EDITMSG", "packed-refs", "shallow",
]);
const GIT_STATE_DIRECTORIES = new Set(["objects", "refs", "logs"]);
// Fail closed rather than accepting an unbounded tree, sparse file, or writer.
const MAX_ENTRIES = 100_000;
const MAX_DEPTH = 128;
const MAX_FILE_BYTES = 256 * 1024 * 1024;
const MAX_BYTES = 1024 * 1024 * 1024;

type Entry = {
	kind: "file" | "dir" | "link";
	mode: number;
	dev: number;
	ino: number;
	nlink: number;
	digest?: string;
	target?: string;
};
type Tree = Map<string, Entry>;
type Budget = { bytes: number; entries: number };
type Directory = { fd: number; path: string; entry: Entry };

function fail(message: string): never {
	throw new Error(`Sandbox workspace: ${message}`);
}

function entry(stat: Stats): Entry {
	const kind = stat.isDirectory() ? "dir" : stat.isFile() ? "file" : stat.isSymbolicLink() ? "link" : undefined;
	if (!kind) fail("special files are not supported");
	return { kind, mode: stat.mode & 0o7777, dev: stat.dev, ino: stat.ino, nlink: stat.nlink };
}

function identity(a: Entry, b: Entry): boolean {
	return a.kind === b.kind && a.dev === b.dev && a.ino === b.ino;
}

function equal(a: Entry | undefined, b: Entry | undefined): boolean {
	return !a || !b ? a === b : a.kind === b.kind && a.mode === b.mode && a.digest === b.digest && a.target === b.target;
}

function unchanged(a: Entry | undefined, b: Entry | undefined): boolean {
	return equal(a, b) && (!a || !b || (identity(a, b) && (a.kind === "dir" || a.nlink === b.nlink)));
}

function stable(a: Stats, b: Stats): boolean {
	return identity(entry(a), entry(b)) && a.mode === b.mode && a.size === b.size &&
		a.nlink === b.nlink && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}

function lstat(path: string): Stats | undefined {
	try { return fs.lstatSync(path); } catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

function directory(path: string, expected?: Entry): Directory {
	const fd = fs.openSync(path, C.O_RDONLY | C.O_DIRECTORY | C.O_NOFOLLOW);
	try {
		const current = entry(fs.fstatSync(fd));
		if (current.kind !== "dir" || (expected && !identity(expected, current))) fail(`directory replaced: ${path}`);
		// Linux pins every ancestor through directory descriptors. Other platforms
		// are useful for tests, but have only path-based checks, not this guarantee.
		return { fd, entry: current, path: process.platform === "linux" ? `/proc/self/fd/${fd}` : path };
	} catch (error) { fs.closeSync(fd); throw error; }
}

/** Hash a bounded regular file, optionally copying to an already-exclusive fd. */
function file(path: string, expected: Stats, budget: Budget, output?: number): Entry {
	const fd = fs.openSync(path, C.O_RDONLY | C.O_NOFOLLOW | C.O_NONBLOCK);
	try {
		const before = fs.fstatSync(fd);
		if (!before.isFile() || !stable(expected, before)) fail(`file replaced: ${path}`);
		if (before.size > MAX_FILE_BYTES || budget.bytes + before.size > MAX_BYTES) fail("payload limit exceeded");
		const hash = createHash("sha256");
		const buffer = Buffer.allocUnsafe(64 * 1024);
		let size = 0;
		for (;;) {
			const count = fs.readSync(fd, buffer, 0, buffer.length, null);
			if (!count) break;
			size += count;
			budget.bytes += count;
			if (size > MAX_FILE_BYTES || budget.bytes > MAX_BYTES) fail("payload limit exceeded");
			hash.update(buffer.subarray(0, count));
			if (output !== undefined) {
				let offset = 0;
				while (offset < count) offset += fs.writeSync(output, buffer, offset, count - offset);
			}
		}
		if (size !== before.size || !stable(before, fs.fstatSync(fd))) fail(`file changed while reading: ${path}`);
		return { ...entry(before), digest: hash.digest("hex") };
	} finally { fs.closeSync(fd); }
}

function inspect(path: string, budget: Budget): Entry | undefined {
	const stat = lstat(path);
	if (!stat) return undefined;
	const result = entry(stat);
	if (result.kind === "file") return file(path, stat, budget);
	if (result.kind === "link") result.target = fs.readlinkSync(path);
	if (!stable(stat, fs.lstatSync(path))) fail(`entry changed while reading: ${path}`);
	return result;
}

/** Never follows symlinks; destination is a fresh, host-owned directory. */
function scan(root: string, expected: Entry, destination?: string, output = false): Tree {
	const tree: Tree = new Map();
	const budget: Budget = { bytes: 0, entries: 0 };
	function walk(path: string, rel: string, parentEntry: Entry, depth: number): void {
		if (depth > MAX_DEPTH) fail("directory depth limit exceeded");
		const dir = directory(path, parentEntry);
		try {
			const before = fs.fstatSync(dir.fd);
			tree.set(rel, entry(before));
			const iterator = fs.opendirSync(dir.path);
			try {
				for (let child = iterator.readSync(); child; child = iterator.readSync()) {
					if (++budget.entries > MAX_ENTRIES) fail("entry limit exceeded");
					const name = rel ? `${rel}/${child.name}` : child.name;
					const source = join(dir.path, child.name);
					const stat = fs.lstatSync(source);
					const item = entry(stat);
					const dest = destination === undefined ? undefined : join(destination, name);
					if (item.kind === "dir") {
						if (dest) fs.mkdirSync(dest, { mode: 0o700 });
						walk(source, name, item, depth + 1);
					} else if (item.kind === "file") {
						if (output && item.nlink !== 1) fail(`hardlink output: ${name}`);
						const fd = dest ? fs.openSync(dest, C.O_WRONLY | C.O_CREAT | C.O_EXCL | C.O_NOFOLLOW, 0o600) : undefined;
						try {
							tree.set(name, file(source, stat, budget, fd));
							if (fd !== undefined) fs.fchmodSync(fd, item.mode);
						} finally { if (fd !== undefined) fs.closeSync(fd); }
					} else {
						item.target = fs.readlinkSync(source);
						if (!stable(stat, fs.lstatSync(source))) fail(`link changed: ${name}`);
						if (dest) fs.symlinkSync(item.target, dest);
						tree.set(name, item);
					}
				}
			} finally { iterator.closeSync(); }
			if (!stable(before, fs.fstatSync(dir.fd))) fail(`directory changed while reading: ${rel}`);
			if (destination !== undefined) fs.chmodSync(join(destination, rel), before.mode & 0o7777);
		} finally { fs.closeSync(dir.fd); }
	}
	walk(root, "", expected, 0);
	return tree;
}

function compareTrees(a: Tree, b: Tree, physical = false): void {
	if (a.size !== b.size) fail("tree changed while staging");
	for (const [path, item] of a) {
		if (!(physical ? unchanged(item, b.get(path)) : equal(item, b.get(path)))) fail(`tree changed while staging: ${path}`);
	}
}

function protectedName(path: string): boolean {
	return path.split("/").some(part => PROTECTED.has(part));
}

/** Only a baseline .git directory can receive ordinary state; gitfiles stay read-only. */
function protectedChange(path: string, baseline: Tree, result: Tree): boolean {
	const parts = path.split("/");
	for (let i = 0; i < parts.length; i++) {
		if (!PROTECTED.has(parts[i]!)) continue;
		if (parts[i] !== ".git") return true;
		const git = parts.slice(0, i + 1).join("/");
		if (baseline.get(git)?.kind !== "dir" || result.get(git)?.kind !== "dir") return true;
		const state = parts.slice(i + 1);
		const name = state[0];
		if (!name) return true;
		if (GIT_STATE_DIRECTORIES.has(name)) {
			if ([baseline.get(`${git}/${name}`), result.get(`${git}/${name}`)].some(item => item && item.kind !== "dir")) return true;
			// Alternates redirect object reads outside this object database.
			if (name === "objects" && state[1] === "info" && ["alternates", "http-alternates"].includes(state[2] ?? "")) return true;
		} else {
			const file = name.endsWith(".lock") ? name.slice(0, -5) : name;
			if (state.length !== 1 || !GIT_STATE_FILES.has(file)) return true;
			if ([baseline.get(path), result.get(path)].some(item => item && item.kind !== "file")) return true;
		}
	}
	return false;
}

// Resolve link text against the in-memory tree, including dangling aliases;
// do not realpath/follow links into the host or the sandbox's live output.
function protectedAliases(tree: Tree, root: string, spelling: string, metadataRoots: string[] = []): string[] {
	const aliases: string[] = [];
	// Keep dot-dot components until after resolving each preceding symlink.
	const canonical = (target: string) => target === spelling || target.startsWith(spelling + sep)
		? root + target.slice(spelling.length) : target;
	for (const [name, item] of tree) {
		if (item.kind !== "link" || (!protectedName(name) && !metadataRoots.some(dir => !dir || name === dir || name.startsWith(dir + "/")))) continue;
		let pending = canonical(`${root}/${name}`).split(sep);
		let parts: string[] = [];
		let hops = 0;
		while (pending.length) {
			const part = pending.shift()!;
			if (!part || part === ".") continue;
			if (part === "..") { parts.pop(); continue; }
			parts.push(part);
			const path = sep + parts.join(sep);
			if (!path.startsWith(root + sep)) continue;
			const link = tree.get(path.slice(root.length + 1));
			if (link?.kind !== "link") continue;
			if (++hops > 40) fail(`protected alias loop: ${name}`);
			parts.pop();
			const target = canonical(link.target!);
			if (target.startsWith(sep)) parts = [];
			pending = [...target.split(sep), ...pending];
		}
		const target = sep + parts.join(sep);
		if (target === root) aliases.push("");
		else if (target.startsWith(root + sep)) aliases.push(target.slice(root.length + 1));
		// Baseline/live trees belong to the host, so resolve external link chains
		// too: a protected symlink can leave the tree and point back inside it.
		const physical = resolveSandboxPath(`${root}/${name}`).path;
		if (physical === root) aliases.push("");
		else if (physical.startsWith(root + sep)) aliases.push(physical.slice(root.length + 1));
	}
	return aliases;
}

/**
 * Private writable snapshot and one-shot validated copyback. The caller must
 * expose ONLY `path` to the sandbox, never its parent or staging directories,
 * and stop/reap the child process group before publishing/cleaning up. A 0700
 * directory alone does not isolate unsandboxed processes running as this uid.
 *
 * Baseline metadata lives only in this closure. Output is frozen in a separate
 * host-only staging directory and rehashed before any host workspace mutation.
 * Limits: 100k entries, depth 128, 256 MiB/file, 1 GiB/tree. No special files,
 * changed symlinks, hardlinked output, or setuid/setgid/sticky output modes.
 *
 * This is NOT a filesystem transaction: Node has no renameat2 compare-and-swap.
 * External host writers can race the final check/rename/unlink (and rollback).
 * Linux directory fds prevent symlink traversal, but cannot prevent an external
 * process moving an already-open directory elsewhere. Rollback checks identities
 * and hashes, skips observed conflicts, and is best effort, not crash recovery.
 * Other platforms lack the Linux descriptor-anchored traversal guarantee.
 */
type Publication = { commit(): void; rollback(): void; cleanup(): void };
type Snapshot = { path: string; stage(): Publication; cleanup(): void };

function prepareSnapshot(cwd: string, gitStateRoots: string[] = [], protection: () => SandboxProtectedPath[] = () => []): Snapshot {
	const host = fs.realpathSync(cwd);
	const hostRoot = entry(fs.lstatSync(host));
	if (hostRoot.kind !== "dir") fail("cwd is not a directory");
	const tempRoot = fs.realpathSync(tmpdir());
	if (tempRoot === host || tempRoot.startsWith(host + sep)) fail("temporary storage must be outside the workspace; choose a separate TMPDIR");
	const parent = fs.mkdtempSync(join(tempRoot, "agav-workspace-"));
	fs.chmodSync(parent, 0o700);
	const parentEntry = entry(fs.lstatSync(parent));
	const path = join(parent, "workspace");
	let baseline: Tree;
	let snapshotRoot: Entry;
	let snapshot: Tree;
	let baselineAliases: string[];
	const baselineProtection = protection();
	try {
		fs.mkdirSync(path, { mode: 0o700 });
		baseline = scan(host, hostRoot, path);
		snapshotRoot = entry(fs.lstatSync(path));
		snapshot = scan(path, snapshotRoot);
		compareTrees(baseline, snapshot);
		baselineAliases = protectedAliases(baseline, host, resolve(cwd), gitStateRoots);
	} catch (error) { fs.rmSync(parent, { recursive: true, force: true }); throw error; }
	let used = false;
	let cleaned = false;

	function cleanup(): void {
		if (cleaned) return;
		// Never recurse through a replaced parent/root symlink. rm removes a final
		// symlink itself; Linux additionally anchors this to the original parent.
		const current = lstat(parent);
		if (!current || !identity(parentEntry, entry(current))) { cleaned = true; return; }
		const dir = directory(parent, parentEntry);
		try { fs.rmSync(join(dir.path, "workspace"), { recursive: true, force: true }); }
		finally { fs.closeSync(dir.fd); }
		fs.rmdirSync(parent);
		cleaned = true;
	}

	function stagePublication(): Publication {
		if (used || cleaned) fail("workspace has already been published or cleaned up");
		used = true;
		const stage = fs.mkdtempSync(join(tmpdir(), "agav-publication-"));
		let retained = false;
		fs.chmodSync(stage, 0o700);
		try {
			const frozen = join(stage, "output");
			fs.mkdirSync(frozen, { mode: 0o700 });
			const result = scan(path, snapshotRoot, frozen, true);
			compareTrees(result, scan(path, snapshotRoot, undefined, true), true);
			compareTrees(result, scan(frozen, entry(fs.lstatSync(frozen)), undefined, true));
			if (!equal(baseline.get(""), result.get(""))) fail("snapshot root mode changed");
			// Content equality cannot detect replacing/renaming an entire .git
			// with an identical tree. Keep the private snapshot inode as well.
			for (const [name, original] of snapshot) {
				if ((name.split("/").at(-1) === ".git" || gitStateRoots.includes(name)) && !unchanged(original, result.get(name))) fail(`protected Git metadata replaced: ${name}`);
				if (original.kind === "link" && !unchanged(original, result.get(name))) fail(`symlink publication: ${name}`);
			}
			const changes = [...new Set([...baseline.keys(), ...result.keys()])]
				.filter(name => name !== "" && !equal(baseline.get(name), result.get(name)));
			const aliases = baselineAliases;
			const metadataTrees = [...gitStateRoots].sort((a, b) => b.length - a.length).map(root => {
				const virtual = (tree: Tree): Tree => new Map([...tree].filter(([key]) => !root || key === root || key.startsWith(root + "/"))
					.map(([key, value]) => [key === root ? ".git" : ".git/" + (root ? key.slice(root.length + 1) : key), value]));
				return { root, before: virtual(baseline), after: virtual(result) };
			});
			for (const name of changes) {
				const before = baseline.get(name);
				const after = result.get(name);
				const metadata = metadataTrees.find(({ root }) => !root || name === root || name.startsWith(root + "/"));
				let protectedEntry = protectedChange(name, baseline, result);
				if (metadata) {
					const relative = metadata.root ? name.slice(metadata.root.length + 1) : name;
					protectedEntry = protectedChange(".git/" + relative, metadata.before, metadata.after);
				}
				if (protectedEntry || aliases.some(alias => !alias || name === alias || name.startsWith(alias + "/") || alias.startsWith(name + "/"))) fail(`protected path changed: ${name}`);
				if (before?.kind === "link" || after?.kind === "link") fail(`symlink publication: ${name}`);
				if (before?.kind === "file" && before.nlink !== 1) fail(`hardlinked host target: ${name}`);
				if (after && (after.mode & 0o7000)) fail(`special permission bits: ${name}`);
			}

			function preflight(): Tree {
				const protectedPaths = [...baselineProtection, ...protection()];
				for (const name of changes) {
					const absolute = join(host, name);
					if (protectedPaths.some(item => item.kind === "ancestor"
						? absolute === item.path && baseline.has(name) && baseline.get(name)?.kind !== result.get(name)?.kind
						: absolute === item.path || (item.kind === "directory" && absolute.startsWith(item.path + sep)))) fail(`protected path changed: ${name}`);
				}
				const live = scan(host, hostRoot);
				const liveAliases = protectedAliases(live, host, resolve(cwd), gitStateRoots);
				for (const name of changes) {
					if (liveAliases.some(alias => !alias || name === alias || name.startsWith(alias + "/") || alias.startsWith(name + "/"))) fail(`host protected alias conflict: ${name}`);
					if (!unchanged(baseline.get(name), live.get(name))) fail(`host conflict: ${name}`);
					for (let p = dirname(name); ; p = dirname(p)) {
						const key = p === "." ? "" : p;
						const original = baseline.get(key);
						if (original && !unchanged(original, live.get(key))) fail(`host parent conflict: ${key}`);
						if (!key) break;
					}
					if (baseline.get(name)?.kind === "dir" && result.get(name)?.kind !== "dir") {
						for (const key of live.keys()) {
							if (key.startsWith(name + "/") && !unchanged(baseline.get(key), live.get(key))) fail(`host subtree conflict: ${key}`);
						}
					}
				}
				return live;
			}
			preflight();
			// Backups are host-only file payloads, not a sandbox-visible manifest.
			const backups = new Map<string, string>();
			const backupBudget = { bytes: 0, entries: 0 };
			for (const name of changes) {
				if (baseline.get(name)?.kind !== "file") continue;
				const backup = join(stage, `backup-${backups.size}`);
				withParent(host, hostRoot, name, baseline, dir => {
					const source = join(dir.path, name.split("/").at(-1)!);
					const fd = fs.openSync(backup, C.O_WRONLY | C.O_CREAT | C.O_EXCL, 0o600);
					try {
						if (!unchanged(baseline.get(name), file(source, fs.lstatSync(source), backupBudget, fd))) fail(`host backup conflict: ${name}`);
					} finally { fs.closeSync(fd); }
				});
				backups.set(name, backup);
			}
			const expected = preflight();
			const journal: { name: string; before?: Entry; after?: Entry }[] = [];
			function mutate(name: string, after: Entry | undefined, payload?: string): Entry | undefined {
				return withParent(host, hostRoot, name, expected, dir => {
					const target = join(dir.path, name.split("/").at(-1)!);
					const before = expected.get(name);
					const check = () => {
						if (!unchanged(before, inspect(target, { bytes: 0, entries: 0 }))) fail(`host conflict during publication: ${name}`);
					};
					check();
					if (!after) {
						if (before?.kind === "dir") fs.rmdirSync(target);
						else fs.unlinkSync(target);
						return undefined;
					}
					if (after.kind === "dir") {
						if (!before) fs.mkdirSync(target, { mode: after.mode });
						const child = directory(target, before);
						try { fs.fchmodSync(child.fd, after.mode); return entry(fs.fstatSync(child.fd)); }
						finally { fs.closeSync(child.fd); }
					}
					const temp = join(dir.path, `.agav-copyback-${randomUUID()}`);
					const fd = fs.openSync(temp, C.O_WRONLY | C.O_CREAT | C.O_EXCL | C.O_NOFOLLOW, 0o600);
					try {
						const copied = file(payload!, fs.lstatSync(payload!), { bytes: 0, entries: 0 }, fd);
						if (copied.digest !== after.digest) fail(`staged content changed: ${name}`);
						fs.fchmodSync(fd, after.mode);
						fs.fsyncSync(fd);
						const installed = { ...entry(fs.fstatSync(fd)), digest: copied.digest };
						check();
						fs.renameSync(temp, target);
						return installed;
					} finally {
						fs.closeSync(fd);
						try { fs.unlinkSync(temp); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
					}
				});
			}
			function apply(name: string, desired: Entry | undefined): void {
				const before = expected.get(name);
				const after = mutate(name, desired, desired?.kind === "file" ? join(frozen, name) : undefined);
				journal.push({ name, before, after });
				if (after) expected.set(name, after); else expected.delete(name);
			}
			const depth = (name: string) => name.split("/").length;
			let committed = false;
			const rollback = () => {
				const failures: unknown[] = [];
				for (const change of journal.reverse()) {
					try {
						// Expected contains our installed inode/hash, never a fresh host
						// value that could authorize overwriting a concurrent edit.
						const restored = mutate(change.name, change.before, backups.get(change.name));
						if (restored) expected.set(change.name, restored); else expected.delete(change.name);
					} catch (rollbackError) { failures.push(rollbackError); }
				}
				if (failures.length) throw new AggregateError(failures, "Sandbox workspace rollback incomplete (host conflicts preserved)");
			};
			retained = true;
			return {
				commit() {
					if (committed) fail("publication already committed");
					preflight();
					committed = true;
					try {
						for (const name of [...changes].sort((a, b) => depth(b) - depth(a))) {
							const before = baseline.get(name);
							const after = result.get(name);
							if (before && (!after || before.kind !== after.kind)) apply(name, undefined);
						}
						for (const name of [...changes].sort((a, b) => depth(a) - depth(b))) {
							const after = result.get(name);
							if (after?.kind === "dir" && !expected.has(name)) apply(name, { ...after, mode: 0o700 });
							if (after?.kind === "file") apply(name, after);
						}
						for (const name of [...changes].sort((a, b) => depth(b) - depth(a))) {
							const after = result.get(name);
							if (after?.kind === "dir" && after.mode !== expected.get(name)?.mode) apply(name, after);
						}
					} catch (error) {
						try { rollback(); } catch (rollbackError) { throw new AggregateError([error, rollbackError], "Publication failed; rollback incomplete"); }
						throw error;
					}
				},
				rollback,
				cleanup() { fs.rmSync(stage, { recursive: true, force: true }); },
			};
		} finally { if (!retained) fs.rmSync(stage, { recursive: true, force: true }); }
	}
	return { path, stage: stagePublication, cleanup };
}

/** Open each host ancestor without following links and compare its baseline inode. */
function withParent<T>(root: string, rootEntry: Entry, name: string, expected: Tree, run: (dir: Directory) => T): T {
	const opened: Directory[] = [];
	try {
		let dir = directory(root, rootEntry);
		opened.push(dir);
		const parts = name.split("/");
		for (let i = 0; i < parts.length - 1; i++) {
			const key = parts.slice(0, i + 1).join("/");
			const wanted = expected.get(key);
			if (wanted?.kind !== "dir") fail(`host parent conflict: ${key}`);
			dir = directory(join(dir.path, parts[i]!), wanted);
			opened.push(dir);
		}
		return run(dir);
	} finally { for (const dir of opened.reverse()) fs.closeSync(dir.fd); }
}

/** A group is validated in full before the first host write. */
export function prepareSandboxWorkspace(cwd: string, includeGitMetadata = false): {
	path: string; mounts: Array<{ source: string; target: string }>; publish(): void; cleanup(): void;
} {
	const snapshots: Array<{ target: string; snapshot: Snapshot }> = [];
	const host = fs.realpathSync(cwd);
	try {
		const protection = includeGitMetadata ? () => discoverSandboxProtectedPaths(host).protectedPaths : () => [];
		const discovered = includeGitMetadata ? discoverSandboxProtectedPaths(host).gitDirectories.filter(path => fs.existsSync(path)) : [];
		const internal = discovered.filter(path => path.startsWith(host + sep)).map(path => path.slice(host.length + 1));
		snapshots.push({ target: host, snapshot: prepareSnapshot(host, internal, protection) });
		if (includeGitMetadata) {
			const directories = discovered.filter(path => path !== host && !path.startsWith(host + sep));
			const roots = directories.filter(path => !directories.some(parent => parent !== path && path.startsWith(parent + sep)));
			for (const root of roots) {
				if (host.startsWith(root + sep)) fail("Git metadata cannot contain the workspace");
				const allowed = directories.filter(path => path === root || path.startsWith(root + sep)).map(path => path === root ? "" : path.slice(root.length + 1));
				snapshots.push({ target: root, snapshot: prepareSnapshot(root, allowed, protection) });
			}
		}
	} catch (error) { for (const { snapshot } of snapshots) snapshot.cleanup(); throw error; }
	return {
		path: snapshots[0]!.snapshot.path,
		mounts: snapshots.slice(1).map(({ target, snapshot }) => ({ target, source: snapshot.path })),
		publish() {
			const publications: Publication[] = [];
			const committed: Publication[] = [];
			try {
				for (const { snapshot } of snapshots) publications.push(snapshot.stage());
				for (const publication of publications) { publication.commit(); committed.push(publication); }
			} catch (error) {
				const failures: unknown[] = [error];
				for (const publication of committed.reverse()) {
					try { publication.rollback(); } catch (cause) { failures.push(cause); }
				}
				if (failures.length > 1) throw new AggregateError(failures, "Sandbox publication failed; rollback incomplete");
				throw error;
			} finally { for (const publication of publications) publication.cleanup(); }
		},
		cleanup() { for (const { snapshot } of snapshots) snapshot.cleanup(); },
	};
}
