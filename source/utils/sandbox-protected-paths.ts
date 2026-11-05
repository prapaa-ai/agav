import { lstatSync, readFileSync, readlinkSync, realpathSync, type Stats } from "node:fs";
import { dirname, isAbsolute, parse, resolve, sep } from "node:path";

export type SandboxProtectedPath = { path: string; kind: "file" | "directory" | "ancestor" };
export type SandboxPathPolicy = {
	protectedPaths: SandboxProtectedPath[];
	gitDirectories: string[];
	/** Only ordinary Git state, never an entire external repository/worktree. */
	gitWritablePaths: Array<{ path: string; kind: "file" | "directory" }>;
};

function stat(path: string): Stats | undefined {
	try { return lstatSync(path); } catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

/** Resolve existing ancestors AND dangling links; unexpected I/O errors fail closed. */
export function resolveSandboxPath(input: string): { path: string; links: string[] } {
	const absolute = isAbsolute(input) ? input : `${process.cwd()}${sep}${input}`;
	let path = parse(absolute).root;
	let pending = absolute.slice(path.length).split(sep);
	const links: string[] = [];
	let hops = 0;
	while (pending.length) {
		const part = pending.shift()!;
		if (!part || part === ".") continue;
		if (part === "..") { path = dirname(path); continue; }
		const next = resolve(path, part);
		const info = stat(next);
		if (info?.isSymbolicLink()) {
			if (++hops > 40) throw new Error(`Sandbox protected path symlink cycle: ${input}`);
			links.push(next);
			const target = readlinkSync(next);
			if (isAbsolute(target)) path = parse(target).root;
			pending = [...target.slice(isAbsolute(target) ? parse(target).root.length : 0).split(sep), ...pending];
		} else {
			path = info ? realpathSync(next) : next;
		}
	}
	return { path, links };
}

function pointer(path: string): string | undefined {
	const info = stat(path);
	if (!info) return undefined;
	if (!info.isFile() || info.size > 64 * 1024) throw new Error(`Invalid Git metadata pointer: ${path}`);
	const text = readFileSync(path, "utf8").replace(/[\r\n]+$/, "");
	if (!text || /[\0\r\n]/.test(text)) throw new Error(`Invalid Git metadata pointer: ${path}`);
	return text;
}

/** Filesystem-only discovery: never execute Git (repository config can execute code). */
export function discoverSandboxProtectedPaths(cwd: string): SandboxPathPolicy {
	const protectedPaths = new Map<string, SandboxProtectedPath>();
	const gitWritablePaths: SandboxPathPolicy["gitWritablePaths"] = [];
	const gitDirectories = new Set<string>();
	function record(path: string, kind: SandboxProtectedPath["kind"]): void {
		const previous = protectedPaths.get(path);
		if (!previous || previous.kind === "ancestor" || kind === "directory") protectedPaths.set(path, { path, kind });
	}
	function ancestors(path: string): void {
		for (let parent = dirname(path); ; parent = dirname(parent)) {
			record(parent, "ancestor");
			if (dirname(parent) === parent) break;
		}
	}
	function protect(path: string, kind: "file" | "directory" | "ancestor"): string {
		const resolved = resolveSandboxPath(path);
		const info = stat(resolved.path);
		if (kind === "file" && info?.isFile() && info.nlink > 1) throw new Error(`Protected file has hardlink aliases: ${path}`);
		for (const name of [resolve(path), resolved.path]) { record(name, kind); ancestors(name); }
		for (const link of resolved.links) { record(link, "file"); ancestors(link); }
		return resolved.path;
	}
	const root = resolveSandboxPath(cwd).path;
	for (const name of [".agav", ".vscode", ".idea"]) protect(`${cwd}/${name}`, "directory");
	for (const name of [".bashrc", ".bash_profile", ".profile", ".zshrc", ".zprofile", ".envrc"]) protect(`${cwd}/${name}`, "file");

	function gitDirectory(path: string): string {
		const dir = protect(path, "ancestor");
		gitDirectories.add(dir);
		for (const name of ["config", "config.worktree", "commondir", "gitdir"]) protect(`${dir}/${name}`, "file");
		protect(`${dir}/hooks`, "directory");
		for (const name of ["alternates", "http-alternates"]) protect(`${dir}/objects/info/${name}`, "file");
		// Restrict external linked-worktree allowances to ordinary Git state.
		for (const name of ["HEAD", "index", "ORIG_HEAD", "FETCH_HEAD", "MERGE_HEAD", "MERGE_MSG", "MERGE_MODE", "AUTO_MERGE", "COMMIT_EDITMSG", "packed-refs", "shallow"]) {
			for (const suffix of ["", ".lock"]) gitWritablePaths.push({ path: `${dir}/${name}${suffix}`, kind: "file" });
		}
		for (const name of ["objects", "refs", "logs"]) gitWritablePaths.push({ path: `${dir}/${name}`, kind: "directory" });
		return dir;
	}

	// A command may run in a subdirectory of a checkout. Protect the closest
	// enclosing repository as well as reserving the cwd's own future .git names.
	let repository = root;
	for (let dir = root; ; dir = dirname(dir)) {
		if (stat(`${dir}/.git`)) { repository = dir; break; }
		if (dirname(dir) === dir) break;
	}
	if (repository !== root) { gitDirectory(`${root}/.git`); protect(`${root}/.git`, "file"); }
	const marker = `${repository}/.git`;
	const resolvedMarker = resolveSandboxPath(marker).path;
	const info = stat(resolvedMarker);
	let gitdir: string;
	if (info?.isFile()) {
		protect(marker, "file");
		const text = pointer(resolvedMarker)!;
		if (!text.startsWith("gitdir: ") || !text.slice(8)) throw new Error(`Invalid Git metadata pointer: ${marker}`);
		const target = text.slice(8);
		gitdir = gitDirectory(isAbsolute(target) ? target : `${dirname(marker)}/${target}`);
	} else {
		if (info && !info.isDirectory()) throw new Error(`Invalid Git metadata directory: ${marker}`);
		gitdir = gitDirectory(marker);
		// An absent marker must not be created as a gitfile redirecting Git to
		// unprotected metadata. Existing directories retain child-write access.
		if (!info) protect(marker, "file");
	}
	const common = pointer(resolveSandboxPath(`${gitdir}/commondir`).path);
	if (common !== undefined) {
		const commonDir = gitDirectory(isAbsolute(common) ? common : `${gitdir}/${common}`);
		if (commonDir === gitdir) throw new Error(`Cyclic Git commondir: ${gitdir}`);
		// Git only follows one commondir; reject chains rather than trusting an
		// ambiguous/cyclic pointer graph or granting additional write roots.
		if (pointer(resolveSandboxPath(`${commonDir}/commondir`).path) !== undefined) throw new Error(`Chained Git commondir: ${commonDir}`);
	}
	return { protectedPaths: [...protectedPaths.values()], gitWritablePaths, gitDirectories: [...gitDirectories] };
}
