import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getEventListeners } from "node:events";
import { readFileSync, rmSync, statSync } from "node:fs";
import { createServer, type IncomingHttpHeaders } from "node:http";
import { dirname } from "node:path";
import { brotliCompressSync, deflateSync, gzipSync, constants } from "node:zlib";

vi.mock("../utils/temp-output.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../utils/temp-output.js")>();
	const { isolatedTempOutputManager } = await import("./helpers/temp-output.js");
	return { ...actual, tempOutputManager: await isolatedTempOutputManager(actual.TempOutputManager) };
});

// Keep URL validation and the real HTTP transport; only DNS and the pinned
// connection address are substituted to reach the local fixture.
vi.mock("../utils/safe-url.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../utils/safe-url.js")>();
	return {
		...actual,
		assertSafeUrl: vi.fn((input: string | URL) => actual.assertSafeUrl(input, {
			resolve: async () => [{ address: "93.184.216.34", family: 4 }],
		})),
		pinnedLookup: vi.fn((target: Parameters<typeof actual.pinnedLookup>[0]) =>
			actual.pinnedLookup({ ...target, address: "127.0.0.1", family: 4 })),
	};
});

import { fetchUrlTool } from "../tools/fetch-url.js";
import { assertSafeUrl, pinnedLookup, type SafeTarget } from "../utils/safe-url.js";

const requests: Array<{ url: string; method: string; headers: IncomingHttpHeaders; body: string }> = [];
const directories = new Set<string>();
const text = "hello compressed é😀 world";
const encoders = { gzip: gzipSync, deflate: deflateSync, br: brotliCompressSync };
let onStream: (() => void) | undefined;
let base: string;
const server = createServer(async (req, res) => {
	res.setHeader("Connection", "close");
	let body = "";
	try { for await (const chunk of req) body += chunk; } catch { return; }
	requests.push({ url: req.url!, method: req.method!, headers: req.headers, body });
	const path = new URL(req.url!, "http://fixture.test").pathname;
	if (path.startsWith("/redirect/")) {
		res.writeHead(Number(path.split("/")[2]), { Location: "/echo" });
		res.end();
	} else if (path === "/cross-origin") {
		res.writeHead(302, { Location: base.replace("fixture.test", "other.test") + "/echo" });
		res.end();
	} else if (path.startsWith("/encoded/")) {
		const encoding = path.split("/")[2] as keyof typeof encoders;
		res.writeHead(200, { "Content-Encoding": encoding });
		res.end(encoders[encoding](text));
	} else if (path === "/quota") {
		res.writeHead(200, { "Content-Encoding": "gzip" });
		res.write(gzipSync("x".repeat(16 * 1024 * 1024 + 1)));
		// Leave the socket open: reaching the decoded quota must cancel it.
	} else if (path === "/corrupt") {
		res.writeHead(200, { "Content-Encoding": "gzip" });
		res.end("not gzip");
	} else if (path === "/truncated") {
		res.writeHead(200, { "Content-Encoding": "gzip" });
		res.end(gzipSync(text).subarray(0, -4));
	} else if (path === "/before-headers") {
		onStream?.();
	} else if (path === "/reset-before-headers") {
		req.socket.destroy();
	} else if (path === "/stream" || path === "/reset-stream") {
		res.writeHead(200, { "Content-Encoding": "gzip" });
		res.write(gzipSync("partial body", { finishFlush: constants.Z_SYNC_FLUSH }), () => {
			// Let the decoder deliver its prefix before interrupting the source.
			setTimeout(() => path === "/reset-stream" ? req.socket.destroy() : onStream?.(), 30);
		});
	} else {
		res.end(JSON.stringify(requests.at(-1)));
	}
});

beforeAll(async () => {
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Missing fixture port");
	base = `http://fixture.test:${address.port}`;
});
afterAll(async () => {
	server.closeAllConnections();
	await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});
const validateNormally = vi.mocked(assertSafeUrl).getMockImplementation()!;
beforeEach(() => {
	requests.length = 0;
	vi.mocked(assertSafeUrl).mockReset().mockImplementation(validateNormally);
});
afterEach(() => {
	onStream = undefined;
	server.closeAllConnections();
	for (const directory of directories) rmSync(directory, { recursive: true, force: true });
	directories.clear();
	vi.restoreAllMocks();
	vi.mocked(assertSafeUrl).mockClear();
	vi.mocked(pinnedLookup).mockClear();
});

const execute = (path: string, input: Record<string, unknown> = {}) => fetchUrlTool.execute({ url: base + path, ...input });
function controlledTimeout() {
	const controller = new AbortController();
	vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
	return controller;
}

// A short, bounded observation window, not the tool's 30-second timeout.
async function settlesSoon<T>(promise: Promise<T>): Promise<T | "still pending"> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([promise, new Promise<"still pending">((resolve) => {
			timer = setTimeout(() => resolve("still pending"), 150);
		})]);
	} finally { clearTimeout(timer); }
}

describe("real pinned HTTP redirects", () => {
	it.each([300, 304, 305, 306, 309])("does not follow status %i with Location", async (status) => {
		const result = await execute(`/redirect/${status}`);
		expect(result.output).toMatch(new RegExp(`^HTTP ${status} `));
		expect(requests).toHaveLength(1);
		expect(assertSafeUrl).toHaveBeenCalledTimes(1);
	});

	it.each([301, 302, 303, 307, 308].flatMap((status) =>
		["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"].map((method) => ({ status, method })),
	))("uses Fetch method/body semantics for $method + $status", async ({ status, method }) => {
		const body = method === "GET" || method === "HEAD" ? undefined : "payload";
		const result = await execute(`/redirect/${status}`, {
			method, body, headers: body ? { "Content-Length": String(Buffer.byteLength(body)) } : {},
		});
		expect(result.isError).toBe(false);
		const dropped = (status === 303 && method !== "GET" && method !== "HEAD") ||
			((status === 301 || status === 302) && method === "POST");
		expect(requests).toHaveLength(2);
		expect(requests[1]).toMatchObject({ method: dropped ? "GET" : method, body: dropped ? "" : body ?? "" });
		expect(assertSafeUrl).toHaveBeenCalledTimes(2);
	});

	it.each(["length", "chunked"])("drops all mixed-case body headers (%s) when rewriting", async (framing) => {
		const controller = controlledTimeout();
		const timer = setTimeout(() => controller.abort(), 500);
		try {
			const result = await execute("/redirect/303", {
				method: "POST", body: "{}",
				headers: {
					...(framing === "length" ? { "cOnTeNt-LeNgTh": "2" } : { "tRaNsFeR-EnCoDiNg": "chunked" }),
					"cOnTeNt-TyPe": "application/json", "cOnTeNt-EnCoDiNg": "identity",
					"cOnTeNt-LaNgUaGe": "en", "cOnTeNt-LoCaTiOn": "/original", "X-Keep": "yes",
				},
			});
			expect(result.isError).toBe(false);
			for (const name of ["content-length", "content-type", "content-encoding", "content-language", "content-location", "transfer-encoding"]) {
				expect(requests[1]!.headers[name]).toBeUndefined();
			}
			expect(requests[1]!.headers["x-keep"]).toBe("yes");
		} finally { clearTimeout(timer); }
	});

	it("still strips credentials on cross-origin redirects", async () => {
		const result = await execute("/cross-origin", { headers: {
			Authorization: "secret", Cookie: "secret", "Proxy-Authorization": "secret",
		} });
		expect(result.isError).toBe(false);
		for (const name of ["authorization", "cookie", "proxy-authorization"]) expect(requests[1]!.headers[name]).toBeUndefined();
	});
});

describe("decoded HTTP capture and failure propagation", () => {
	it.each(["gzip", "deflate", "br"])("decodes %s before text capture", async (encoding) => {
		expect(await execute(`/encoded/${encoding}`, { headers: { "Accept-Encoding": encoding } }))
			.toEqual({ output: `HTTP 200 OK\n${text}`, isError: false });
	});

	it("does not try to decompress an empty HEAD response", async () => {
		expect(await execute("/encoded/gzip", { method: "HEAD" })).toEqual({ output: "HTTP 200 OK\n", isError: false });
	});

	it("enforces the quota on decompressed bytes and cancels an unfinished source", async () => {
		const controller = controlledTimeout();
		const timer = setTimeout(() => controller.abort(), 2000);
		try {
			const result = await execute("/quota");
			const path = result.output.match(/Partial response saved to: (.+)\n/)?.[1];
			if (path) directories.add(dirname(path));
			expect(result.isError).toBe(false);
			expect(result.output).toContain("16 MiB limit reached");
			expect(result.output).not.toContain("response read failed");
			expect(path).toBeDefined();
			expect(statSync(path!).size).toBe(16 * 1024 * 1024);
			expect(readFileSync(path!, "utf8")).toBe("x".repeat(16 * 1024 * 1024));
		} finally { clearTimeout(timer); }
	});

	it.each(["corrupt", "truncated"])("reports %s compressed bodies as streamed failures", async (path) => {
		const result = await execute(`/${path}`);
		expect(result.isError).toBe(true);
		expect(result.output).toMatch(/^HTTP 200 OK\n/);
		expect(result.output).toContain("response read failed");
	});

	it("propagates a source socket failure through the decoder without unhandled errors", async () => {
		const result = await execute("/reset-stream");
		expect(result.isError).toBe(true);
		expect(result.output).toContain("HTTP 200 OK\npartial body");
		expect(result.output).toContain("response read failed");
	});

	it.each(["before-headers", "stream"])("aborts %s without unhandled stream errors", async (path) => {
		const controller = controlledTimeout();
		onStream = () => controller.abort();
		const result = await execute(`/${path}`);
		expect(result.isError).toBe(true);
		if (path === "stream") {
			expect(result.output).toContain("HTTP 200 OK\npartial body");
			expect(result.output).toContain("response read failed");
		} else expect(result.output).toMatch(/^Fetch failed:/);
	});

	it("reports a socket failure before headers", async () => {
		expect(await execute("/reset-before-headers")).toMatchObject({ isError: true, output: expect.stringMatching(/^Fetch failed:/) });
	});
});

describe("abortable URL validation", () => {
	it("does not start validation or HTTP for an already-aborted signal", async () => {
		controlledTimeout().abort();
		expect((await execute("/echo")).isError).toBe(true);
		expect(assertSafeUrl).not.toHaveBeenCalled();
		expect(pinnedLookup).not.toHaveBeenCalled();
		expect(requests).toHaveLength(0);
	});

	it.each([false, true])("interrupts pending DNS (redirect hop: %s) and never sends after late resolution", async (redirect) => {
		const controller = controlledTimeout();
		const normal = vi.mocked(assertSafeUrl).getMockImplementation()!;
		let release!: (target: SafeTarget) => void;
		let entered!: () => void;
		const waiting = new Promise<void>((resolve) => { entered = resolve; });
		if (redirect) vi.mocked(assertSafeUrl).mockImplementationOnce(normal);
		vi.mocked(assertSafeUrl).mockImplementationOnce(() => {
			entered();
			return new Promise<SafeTarget>((resolve) => { release = resolve; });
		});
		const running = execute(redirect ? "/redirect/302" : "/echo");
		await waiting;
		controller.abort(new Error("DNS deadline"));
		const observed = await settlesSoon(running);
		const listeners = getEventListeners(controller.signal, "abort").length;
		release({ url: new URL(base + "/echo"), address: "93.184.216.34", family: 4 });
		await running;
		expect(observed).toMatchObject({ isError: true, output: "Fetch failed: DNS deadline" });
		expect(listeners).toBe(0);
		expect(pinnedLookup).toHaveBeenCalledTimes(redirect ? 1 : 0);
		expect(requests).toHaveLength(redirect ? 1 : 0);
	});

	it("observes late DNS rejection after returning the abort error", async () => {
		const controller = controlledTimeout();
		let rejectDns!: (error: Error) => void;
		vi.mocked(assertSafeUrl).mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectDns = reject; }));
		const running = execute("/echo");
		controller.abort(new Error("DNS deadline"));
		const observed = await settlesSoon(running);
		rejectDns(new Error("late resolver failure"));
		await running;
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(observed).toEqual({ isError: true, output: "Fetch failed: DNS deadline" });
		expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
		expect(pinnedLookup).not.toHaveBeenCalled();
	});

	it("checks the deadline again when validation completes", async () => {
		const controller = controlledTimeout();
		vi.mocked(assertSafeUrl).mockImplementationOnce(async () => {
			controller.abort(new Error("validation deadline"));
			return { url: new URL(base + "/echo"), address: "93.184.216.34", family: 4 };
		});
		expect(await execute("/echo")).toEqual({ isError: true, output: "Fetch failed: validation deadline" });
		expect(pinnedLookup).not.toHaveBeenCalled();
		expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
	});

	it("removes the validation listener before starting HTTP", async () => {
		const controller = controlledTimeout();
		const lookup = vi.mocked(pinnedLookup).getMockImplementation()!;
		vi.mocked(pinnedLookup).mockImplementationOnce((target) => {
			expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
			return lookup(target);
		});
		expect((await execute("/echo")).isError).toBe(false);
	});

	it("removes the abort listener when URL validation rejects", async () => {
		const controller = controlledTimeout();
		vi.mocked(assertSafeUrl).mockRejectedValueOnce(new Error("DNS failed"));
		expect(await execute("/echo")).toEqual({ isError: true, output: "Fetch failed: DNS failed" });
		expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
		expect(pinnedLookup).not.toHaveBeenCalled();
	});
});
