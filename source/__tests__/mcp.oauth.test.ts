import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

const mocks = vi.hoisted(() => ({ home: "", browser: vi.fn() }));
vi.mock("node:os", async (original) => ({ ...await original<typeof import("node:os")>(), homedir: () => mocks.home }));
vi.mock("../utils/open-external.js", () => ({ openExternal: mocks.browser }));
import { MCPOAuth, MCPAuthenticationRequiredError } from "../mcp/oauth.js";
import { MCPClient } from "../mcp/client.js";
import { MCPManager } from "../mcp/manager.js";
import { decrypt, encrypt } from "../utils/encrypt.js";

describe("MCP SDK OAuth", () => {
  let server: Server;
  let origin: string;
  let tokens: URLSearchParams[];
  let registrations: number;
  let requests: Array<string | undefined>;
  let insecureEndpoint: string | undefined;
  let tokenRedirect: boolean;
  let refreshInvalid: boolean;
  let denyAccess: boolean;
  let clients: MCPOAuth[];
  let authMethods: string[];
  let rpc = false;
  let challengeScheme = "Bearer";
  let tokenAuth: Array<string | undefined>;
  let registrationDenied = false;
  let tokenDenied = false;

  beforeEach(async () => {
    mocks.home = await mkdtemp(join(tmpdir(), "agav-oauth-test-"));
    tokens = []; registrations = 0; requests = []; clients = [];
    registrationDenied = false; tokenDenied = false; rpc = false; challengeScheme = "Bearer"; tokenAuth = []; authMethods = ["none"]; insecureEndpoint = undefined; tokenRedirect = false; refreshInvalid = false; denyAccess = false;
    server = createServer(async (request, response) => {
      const path = new URL(request.url!, origin).pathname;
      const json = (value: unknown, status = 200) => response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));
      if (path.startsWith("/.well-known/oauth-protected-resource")) {
        json({ resource: `${origin}/mcp`, authorization_servers: [origin], scopes_supported: ["tools"] });
      } else if (path === "/.well-known/oauth-authorization-server") {
        json({ issuer: origin, authorization_endpoint: `${origin}/authorize`, token_endpoint: insecureEndpoint ?? `${origin}/token`,
          registration_endpoint: `${origin}/register`, response_types_supported: ["code"],
          token_endpoint_auth_methods_supported: authMethods, code_challenge_methods_supported: ["S256"] });
      } else if (path === "/register") {
        registrations++;
        if (registrationDenied) { response.writeHead(403, { "content-type": "application/json" }).end("Forbidden"); return; }
        let body = ""; for await (const chunk of request) body += chunk;
        const metadata = JSON.parse(body);
        if (!authMethods.includes(metadata.token_endpoint_auth_method)) { json({ error: "invalid_client_metadata" }, 400); return; }
        json({ ...metadata, client_id: "registered-client", ...(metadata.token_endpoint_auth_method !== "none" ? { client_secret: "client-secret" } : {}) }, 201);
      } else if (path === "/token") {
        let body = ""; for await (const chunk of request) body += chunk;
        const params = new URLSearchParams(body); tokens.push(params); tokenAuth.push(request.headers.authorization);
        if (tokenDenied) { response.writeHead(403, { "content-type": "text/plain" }).end("Forbidden private-server-detail"); return; }
        if (tokenRedirect) { response.writeHead(302, { location: `${origin}/stolen` }).end(); return; }
        if (refreshInvalid && params.get("grant_type") === "refresh_token") { json({ error: "invalid_grant" }, 400); return; }
        json({ access_token: `access-${tokens.length}`, refresh_token: "refresh-secret", token_type: "Bearer", expires_in: 3600 });
      } else if (path === "/mcp" || path === "/other") {
        requests.push(request.headers.authorization);
        if (!denyAccess && request.headers.authorization) {
          if (rpc) {
            let body = ""; for await (const chunk of request) body += chunk;
            const message = JSON.parse(body);
            if (message.method === "notifications/initialized") response.writeHead(202).end();
            else json({ jsonrpc: "2.0", id: message.id, result: message.method === "initialize" ? { capabilities: {} } :
              message.method === "tools/list" ? { tools: [{ name: "design", inputSchema: { type: "object" } }] } : { content: [{ type: "text", text: "design context" }] } });
          } else json({ ok: true });
        }
        else response.writeHead(401, { "www-authenticate": `${challengeScheme} resource_metadata="${origin}/.well-known/oauth-protected-resource", scope="tools"` }).end();
      } else if (path === "/public") json({ ok: true });
      else json({ error: "not_found" }, 404);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    origin = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
    mocks.browser.mockReset();
    mocks.browser.mockImplementation(async (value: string) => {
      const url = new URL(value);
      const callback = new URL(url.searchParams.get("redirect_uri")!);
      callback.searchParams.set("state", url.searchParams.get("state")!);
      callback.searchParams.set("code", "test-code");
      expect((await fetch(callback)).status).toBe(200);
      return true;
    });
  });

  afterEach(async () => {
    await Promise.all(clients.map(client => client.disconnect()));
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(mocks.home, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function client(interactive = true, extra: Record<string, unknown> = {}) {
    const instance = new MCPOAuth("test", { type: "remote", url: `${origin}/mcp`, ...extra }, interactive);
    clients.push(instance); return instance;
  }
  async function credentialFile() {
    const directory = join(mocks.home, ".agav", "mcp-auth");
    return join(directory, (await readdir(directory)).find(name => name.endsWith(".json"))!);
  }

  it("leaves unauthenticated servers alone", async () => {
    expect((await client().fetch(`${origin}/public`, {})).status).toBe(200);
    expect(mocks.browser).not.toHaveBeenCalled();
    expect(registrations).toBe(0);
    await expect(readdir(join(mocks.home, ".agav", "mcp-auth"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["Authorization", "authorization", "AUTHORIZATION"])("preserves static %s and skips OAuth even on 401", async (key) => {
    denyAccess = true;
    const result = await client().fetch(`${origin}/mcp`, { headers: { [key]: "Basic fixed" } });
    expect(result.status).toBe(401); expect(requests).toEqual(["Basic fixed"]);
    expect(mocks.browser).not.toHaveBeenCalled();
  });

  it("also preserves configured static authorization", async () => {
    expect((await client(true, { headers: { authorization: "Bearer configured" } }).fetch(`${origin}/mcp`, {})).status).toBe(200);
    expect(requests).toEqual(["Bearer configured"]); expect(registrations).toBe(0);
  });

  it("respects oauth:false", async () => {
    expect((await client(true, { oauth: false }).fetch(`${origin}/mcp`, {})).status).toBe(401);
    expect(mocks.browser).not.toHaveBeenCalled();
  });

  it("uses SDK discovery, DCR, PKCE and one replay; encrypts atomically with private permissions", async () => {
    const oauth = client();
    await expect(oauth.fetch(`${origin}/mcp`, {})).rejects.toBeInstanceOf(MCPAuthenticationRequiredError);
    expect(mocks.browser).not.toHaveBeenCalled();
    await oauth.auth();
    expect((await oauth.fetch(`${origin}/mcp`, {})).status).toBe(200);
    expect(requests).toEqual([undefined, "Bearer access-1"]);
    expect(registrations).toBe(1);
    const authorization = new URL(mocks.browser.mock.calls[0]![0]);
    expect(authorization.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorization.searchParams.get("code_challenge")).toBe(createHash("sha256").update(tokens[0]!.get("code_verifier")!).digest("base64url"));
    expect(tokens[0]!.get("grant_type")).toBe("authorization_code");
    expect(tokens[0]!.get("resource")).toBe(`${origin}/mcp`);
    const path = await credentialFile();
    const stored = await readFile(path, "utf8");
    expect(stored.startsWith("enc:")).toBe(true); expect(stored).not.toContain("refresh-secret");
    expect(JSON.parse(decrypt(stored)).tokens.issuer).toBe(origin);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await readdir(join(mocks.home, ".agav", "mcp-auth"))).toHaveLength(1);
    expect((await client(false).fetch(`${origin}/mcp`, {})).status).toBe(200);
    expect(mocks.browser).toHaveBeenCalledTimes(1);
  });

  it("synchronizes concurrent requests across instances", async () => {
    const instances = Array.from({ length: 5 }, () => client());
    await Promise.all(instances.map(instance => instance.auth()));
    const results = await Promise.all(instances.map(instance => instance.fetch(`${origin}/mcp`, {})));
    expect(results.every(result => result.status === 200)).toBe(true);
    expect(registrations).toBe(1); expect(tokens).toHaveLength(1); expect(mocks.browser).toHaveBeenCalledTimes(1);
  });

  it("refreshes a rejected cached token in headless mode and only retries once", async () => {
    await client().auth();
    denyAccess = true;
    expect((await client(false).fetch(`${origin}/mcp`, {})).status).toBe(401);
    expect(tokens[1]!.get("grant_type")).toBe("refresh_token");
    expect(tokens[1]!.get("refresh_token")).toBe("refresh-secret");
    expect(requests).toEqual(["Bearer access-1", "Bearer access-2"]);
    expect(mocks.browser).toHaveBeenCalledTimes(1);
  });

  it("refreshes expired tokens before making an authenticated request", async () => {
    await client().auth();
    const now = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 3_700_000);
    expect((await client(false).fetch(`${origin}/mcp`, {})).status).toBe(200);
    now.mockRestore();
    expect(tokens[1]!.get("grant_type")).toBe("refresh_token");
    expect(requests).toEqual(["Bearer access-2"]);
  });

  it("gives actionable headless errors but explicit auth opens the browser", async () => {
    const oauth = client(false);
    await expect(oauth.fetch(`${origin}/mcp`, {})).rejects.toThrow("agav mcp auth test");
    expect(registrations).toBe(0); expect(mocks.browser).not.toHaveBeenCalled();
    await oauth.auth(); expect(mocks.browser).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])("does not open a browser if refresh is invalid (TTY: %s)", async interactive => {
    await client().auth(); refreshInvalid = true; denyAccess = true;
    await expect(client(interactive).fetch(`${origin}/mcp`, {})).rejects.toBeInstanceOf(MCPAuthenticationRequiredError);
    expect(mocks.browser).toHaveBeenCalledTimes(1);
  });

  it("isolates credentials by configuration and disconnect removes only its own file", async () => {
    const first = client(); await first.auth();
    const second = client(true, { oauth: { scopes: ["different"] } }); await second.auth();
    expect(registrations).toBe(2);
    await first.disconnect();
    expect(await readdir(join(mocks.home, ".agav", "mcp-auth"))).toHaveLength(1);
    expect((await second.fetch(`${origin}/mcp`, {})).status).toBe(200);
  });

  it("supports configured issuer/client ID/scopes without DCR", async () => {
    await client(true, { oauth: { issuer: origin, clientId: "pre-registered", scopes: ["custom"] } }).auth();
    expect(registrations).toBe(0);
    const authorization = new URL(mocks.browser.mock.calls[0]![0]);
    expect(authorization.searchParams.get("client_id")).toBe("pre-registered");
    expect(authorization.searchParams.get("scope")).toBe("custom");
  });

  it("rejects insecure endpoints before registering or transmitting credentials", async () => {
    insecureEndpoint = "http://example.com/token";
    await expect(client().auth()).rejects.toThrow("requires HTTPS");
    expect(registrations).toBe(0); expect(tokens).toHaveLength(0); expect(mocks.browser).not.toHaveBeenCalled();
  });

  it("does not follow token endpoint redirects", async () => {
    tokenRedirect = true;
    await expect(client().auth()).rejects.toThrow();
    expect(tokens).toHaveLength(1);
  });

  it("rejects credential requests to a different origin", async () => {
    await client().auth();
    await expect(client(false).fetch("https://example.com/mcp", {})).rejects.toThrow("different origin");
  });

  it("rejects invalid state, then accepts a valid callback", async () => {
    mocks.browser.mockImplementation(async (value: string) => {
      const url = new URL(value); const callback = new URL(url.searchParams.get("redirect_uri")!);
      callback.searchParams.set("code", "test-code"); callback.searchParams.set("state", "wrong");
      expect((await fetch(callback)).status).toBe(400);
      callback.searchParams.set("state", url.searchParams.get("state")!);
      expect((await fetch(callback)).status).toBe(200); return true;
    });
    await client().auth(); expect(tokens).toHaveLength(1);
  });

  it.each(["abort", "disconnect", "timeout"])("cleans up loopback callback on %s", async (mode) => {
    let callback!: URL;
    let opened!: () => void;
    const ready = new Promise<void>(resolve => { opened = resolve; });
    mocks.browser.mockImplementation(async (value: string) => {
      callback = new URL(new URL(value).searchParams.get("redirect_uri")!); opened(); return true;
    });
    const oauth = client(true, { oauth: { timeoutSeconds: 0.05 } });
    const controller = new AbortController();
    const pending = oauth.auth(controller.signal);
    const assertion = expect(pending).rejects.toThrow(mode === "timeout" ? "timed out" : mode === "disconnect" ? "disconnected" : "abort");
    await ready;
    if (mode === "abort") controller.abort(new Error("abort"));
    if (mode === "disconnect") await oauth.disconnect();
    await assertion;
    await expect(fetch(callback)).rejects.toThrow();
    expect(tokens).toHaveLength(0);
  });

  it("supports Figma-style confidential DCR authentication methods", async () => {
    authMethods = ["client_secret_basic", "client_secret_post"];
    await client().auth();
    const stored = JSON.parse(decrypt(await readFile(await credentialFile(), "utf8")));
    expect(stored.client.token_endpoint_auth_method).toBe("client_secret_basic");
    expect(stored.client.client_secret).toBe("client-secret");
    expect(tokenAuth[0]).toBe(`Basic ${Buffer.from("registered-client:client-secret").toString("base64")}`);
    expect(tokens).toHaveLength(1);
  });

  it("refresh does not need to bind the registered callback port", async () => {
    await client().auth();
    const stored = JSON.parse(decrypt(await readFile(await credentialFile(), "utf8")));
    const occupied = createServer();
    await new Promise<void>(resolve => occupied.listen(stored.callbackPort, "127.0.0.1", resolve));
    denyAccess = true;
    try { expect((await client(false).fetch(`${origin}/mcp`, {})).status).toBe(401); }
    finally { await new Promise<void>(resolve => occupied.close(() => resolve())); }
    expect(tokens[1]!.get("grant_type")).toBe("refresh_token");
  });

  it("does not abort a healthy SSE response body after the header timeout", async () => {
    vi.useFakeTimers();
    const signal = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("stream"));
    try {
      const response = await client().fetch(`${origin}/public`, {});
      const requestSignal = signal.mock.calls[0]![1]!.signal!;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(requestSignal.aborted).toBe(false);
      expect(await response.text()).toBe("stream");
    } finally { vi.useRealTimers(); signal.mockRestore(); }
  });

  it.each([{}, { oauth: false }, { headers: { Authorization: "Bearer private" } }])("blocks cross-origin endpoints regardless of auth mode %j", async extra => {
    await expect(client(true, extra).fetch("https://example.com/steal", {})).rejects.toThrow("different origin");
  });


  it("connects an MCPClient through OAuth and discovers and calls tools", async () => {
    rpc = true;
    // Pre-authenticate explicitly as in a non-TTY CLI, then reuse credentials at startup.
    await client().auth();
    const mcp = new MCPClient("test", { url: `${origin}/mcp`, transport: "http" });
    try {
      await mcp.start();
      expect(mcp.getTools()[0]!.name).toBe("test__design");
      expect(await mcp.callTool("test__design", {})).toEqual({ output: "design context", isError: false });
      expect(mocks.browser).toHaveBeenCalledTimes(1);
    } finally { mcp.stop(); }
  });

  it("does not initiate OAuth on an explicitly non-Bearer challenge", async () => {
    challengeScheme = "Basic";
    expect((await client().fetch(`${origin}/mcp`, {})).status).toBe(401);
    expect(mocks.browser).not.toHaveBeenCalled(); expect(registrations).toBe(0);
  });

  it("reports denied consent and closes its callback", async () => {
    let callback!: URL;
    mocks.browser.mockImplementation(async (value: string) => {
      const url = new URL(value); callback = new URL(url.searchParams.get("redirect_uri")!);
      callback.searchParams.set("state", url.searchParams.get("state")!);
      callback.searchParams.set("error", "access_denied");
      expect((await fetch(callback)).status).toBe(400); return true;
    });
    await expect(client().auth()).rejects.toThrow("denied");
    await expect(fetch(callback)).rejects.toThrow(); expect(tokens).toHaveLength(0);
  });

  it("rejects a mismatched callback issuer before exchanging the code", async () => {
    mocks.browser.mockImplementation(async (value: string) => {
      const url = new URL(value); const callback = new URL(url.searchParams.get("redirect_uri")!);
      callback.searchParams.set("state", url.searchParams.get("state")!);
      callback.searchParams.set("code", "test-code"); callback.searchParams.set("iss", "https://wrong.example.com");
      expect((await fetch(callback)).status).toBe(400); return true;
    });
    await expect(client().auth()).rejects.toThrow("issuer mismatch"); expect(tokens).toHaveLength(0);
  });

  it("reports browser launch failure without waiting for the login timeout", async () => {
    mocks.browser.mockResolvedValue(false);
    await expect(client().auth()).rejects.toThrow("Cannot open the browser"); expect(tokens).toHaveLength(0);
  });

  it("explains a plain-text registration denial without a misleading JSON parse error", async () => {
    registrationDenied = true;
    await expect(client().auth()).rejects.toThrow(`OAuth client registration denied (HTTP 403) at ${origin}/register`);
    expect(mocks.browser).not.toHaveBeenCalled(); expect(tokens).toHaveLength(0);
  });

  it("identifies the token endpoint when an OAuth POST is denied, without leaking its response", async () => {
    tokenDenied = true;
    try {
      await client().auth();
      expect.fail("Expected the token request to fail");
    } catch (error) {
      expect((error as Error).message).toContain(`OAuth token request failed (HTTP 403) at ${origin}/token`);
      expect((error as Error).message).not.toContain("private-server-detail");
      expect((error as Error).message).not.toContain("JSON");
    }
  });

  it("tracks a real startup authentication challenge without registration or browser launch", async () => {
    const manager = new MCPManager();
    try {
      await expect(manager.startServer("test", { url: `${origin}/mcp`, transport: "http" })).rejects.toBeInstanceOf(MCPAuthenticationRequiredError);
      expect(manager.getAuthenticationRequired()).toEqual(["test"]);
      expect(manager.getServerNames()).toEqual([]);
      expect(registrations).toBe(0); expect(mocks.browser).not.toHaveBeenCalled();
    } finally { manager.stopAll(); }
  });

  it("explicit manager login reconnects tools and decreases only its pending count", async () => {
    rpc = true;
    const manager = new MCPManager();
    const config = { url: `${origin}/mcp`, transport: "http" as const };
    const other = { url: `${origin}/other`, transport: "http" as const };
    const oauth = new MCPOAuth("second", other); clients.push(oauth);
    try {
      await expect(manager.startServer("test", config)).rejects.toBeInstanceOf(MCPAuthenticationRequiredError);
      await expect(manager.startServer("second", other)).rejects.toBeInstanceOf(MCPAuthenticationRequiredError);
      expect(manager.getAuthenticationRequired()).toEqual(["second", "test"]);
      const changed = vi.fn(); manager.setOnChange(changed);
      await manager.authenticateServer("test", config);
      expect(manager.getAuthenticationRequired()).toEqual(["second"]);
      expect(manager.getServerNames()).toEqual(["test"]);
      expect(manager.getAllTools()[0]!.name).toBe("test__design");
      expect(changed).toHaveBeenCalledOnce();
    } finally { manager.stopAll(); }
  });

  it("keeps pending authentication on denial and permits a later retry", async () => {
    rpc = true;
    const manager = new MCPManager(); const config = { url: `${origin}/mcp`, transport: "http" as const };
    await expect(manager.startServer("test", config)).rejects.toBeInstanceOf(MCPAuthenticationRequiredError);
    mocks.browser.mockResolvedValueOnce(false);
    try {
      await expect(manager.authenticateServer("test", config)).rejects.toThrow("Cannot open the browser");
      expect(manager.getAuthenticationRequired()).toEqual(["test"]);
      expect(manager.getServerNames()).toEqual([]);
      await manager.authenticateServer("test", config);
      expect(manager.getAuthenticationRequired()).toEqual([]);
    } finally { manager.stopAll(); }
  });

  it.each(["cancel", "stopAll"])("%s cleans up explicit login, avoids reconnecting, and blocks duplicate login", async action => {
    const manager = new MCPManager(); const config = { url: `${origin}/mcp`, transport: "http" as const };
    await expect(manager.startServer("test", config)).rejects.toBeInstanceOf(MCPAuthenticationRequiredError);
    let callback!: URL; let ready!: () => void;
    const opened = new Promise<void>(resolve => { ready = resolve; });
    mocks.browser.mockImplementation(async value => {
      callback = new URL(new URL(value).searchParams.get("redirect_uri")!); ready(); return true;
    });
    const login = manager.authenticateServer("test", config);
    const rejected = expect(login).rejects.toThrow("cancelled");
    try {
      await opened;
      await expect(manager.authenticateServer("test", config)).rejects.toThrow("already authenticating");
      if (action === "cancel") manager.cancelAuthentication(); else manager.stopAll();
      await rejected;
      expect(manager.getAuthenticationRequired()).toEqual(["test"]);
      expect(manager.getServerNames()).toEqual([]);
      await expect(fetch(callback)).rejects.toThrow();
      expect(tokens).toHaveLength(0);
    } finally { manager.stopAll(); }
  });

  it("distinguishes OAuth completion from failed MCP discovery", async () => {
    rpc = true;
    const manager = new MCPManager(); const config = { url: `${origin}/mcp`, transport: "http" as const };
    await expect(manager.startServer("test", config)).rejects.toBeInstanceOf(MCPAuthenticationRequiredError);
    mocks.browser.mockImplementationOnce(async value => {
      const url = new URL(value); const callback = new URL(url.searchParams.get("redirect_uri")!);
      callback.searchParams.set("state", url.searchParams.get("state")!); callback.searchParams.set("code", "test-code");
      await fetch(callback); denyAccess = true; return true;
    });
    try {
      await expect(manager.authenticateServer("test", config)).rejects.toThrow("OAuth succeeded, but MCP connection failed");
      expect(tokens.length).toBeGreaterThan(0);
      expect(manager.getServerNames()).toEqual([]);
    } finally { manager.stopAll(); }
  });

  it("logout removes only its own credentials and tools, and allows explicit reauthentication", async () => {
    rpc = true;
    const manager = new MCPManager(); const config = { url: `${origin}/mcp`, transport: "http" as const };
    const otherOAuth = new MCPOAuth("other", config); clients.push(otherOAuth);
    try {
      await manager.authenticateServer("test", config);
      await manager.authenticateServer("other", config);
      const changed = vi.fn(); manager.setOnChange(changed);
      await manager.logoutServer("test", config);
      expect(manager.getServerNames()).toEqual(["other"]);
      expect(manager.getAllTools().map(tool => tool.serverName)).toEqual(["other"]);
      expect(manager.getAuthenticationRequired()).toEqual(["test"]);
      expect(await readdir(join(mocks.home, ".agav", "mcp-auth"))).toHaveLength(1);
      expect(changed).toHaveBeenCalledOnce();
      await expect(client().fetch(`${origin}/mcp`, {})).rejects.toBeInstanceOf(MCPAuthenticationRequiredError);
      await manager.logoutServer("test", config); // Idempotent when already logged out.
      await manager.authenticateServer("test", config);
      expect(manager.getAuthenticationRequired()).toEqual([]);
      expect(manager.getServerNames()).toContain("test");
    } finally { manager.stopAll(); }
  });

  it("logout cancels pending browser authorization and deletes its registration", async () => {
    const manager = new MCPManager(); const config = { url: `${origin}/mcp`, transport: "http" as const };
    let ready!: () => void; let callback!: URL;
    const opened = new Promise<void>(resolve => { ready = resolve; });
    mocks.browser.mockImplementation(async value => {
      callback = new URL(new URL(value).searchParams.get("redirect_uri")!); ready(); return true;
    });
    const login = manager.authenticateServer("test", config);
    const rejected = expect(login).rejects.toThrow("logout");
    try {
      await opened;
      await manager.logoutServer("test", config);
      await rejected;
      await expect(fetch(callback)).rejects.toThrow();
      expect(await readdir(join(mocks.home, ".agav", "mcp-auth"))).toEqual([]);
      expect(manager.getServerNames()).toEqual([]);
      expect(manager.getAuthenticationRequired()).toEqual(["test"]);
    } finally { manager.stopAll(); }
  });

  it.each<import("../mcp/types.js").MCPServerConfig>([{ oauth: false }, { headers: { authorization: "Bearer static" } }, { headers: { AUTHORIZATION: "Bearer static" } }])("rejects OAuth logout for configured credentials %j", async extra => {
    const manager = new MCPManager();
    await expect(manager.logoutServer("test", { url: `${origin}/mcp`, ...extra })).rejects.toThrow("configured authentication");
    expect(manager.getAuthenticationRequired()).toEqual([]);
  });

  it("rejects OAuth logout for a stdio server", async () => {
    await expect(new MCPManager().logoutServer("local", { command: "node" })).rejects.toThrow("not a configured remote server");
  });

  it("does not emit authorization activity for a cached token or concurrent auth no-op", async () => {
    const activity = vi.fn();
    const oauth = new MCPOAuth("test", { url: `${origin}/mcp` }, true, activity); clients.push(oauth);
    await Promise.all([oauth.auth(), oauth.auth(), oauth.auth()]);
    expect(activity.mock.calls).toEqual([[true], [false]]);
    activity.mockClear();
    await oauth.auth();
    expect(activity).not.toHaveBeenCalled();
  });

  it("does not pause requests when a challenge requires explicit login", async () => {
    const activity = vi.fn();
    const oauth = new MCPOAuth("test", { url: `${origin}/mcp` }, false, activity); clients.push(oauth);
    await expect(oauth.fetch(`${origin}/mcp`, {})).rejects.toBeInstanceOf(MCPAuthenticationRequiredError);
    expect(activity).not.toHaveBeenCalled();
  });

  it("provides recovery instructions when a saved callback port is occupied", async () => {
    const oauth = client(); await oauth.auth();
    const file = await credentialFile();
    const stored = JSON.parse(decrypt(await readFile(file, "utf8")));
    delete stored.tokens; delete stored.expiresAt;
    await writeFile(file, encrypt(JSON.stringify(stored)));
    const occupied = createServer();
    await new Promise<void>(resolve => occupied.listen(stored.callbackPort, "127.0.0.1", resolve));
    try {
      await expect(oauth.auth()).rejects.toThrow(`MCP OAuth callback port ${stored.callbackPort} is already in use`);
      await expect(oauth.auth()).rejects.toThrow("agav mcp logout test");
      expect(JSON.parse(decrypt(await readFile(file, "utf8"))).callbackPort).toBe(stored.callbackPort);
      expect(mocks.browser).toHaveBeenCalledTimes(1);
    } finally { await new Promise<void>(resolve => occupied.close(() => resolve())); }
  });

  it("rejects an already aborted signal without opening a browser", async () => {
    const controller = new AbortController(); controller.abort();
    await expect(client().auth(controller.signal)).rejects.toThrow();
    expect(mocks.browser).not.toHaveBeenCalled();
  });
});
