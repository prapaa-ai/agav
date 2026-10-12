import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  auth as sdkAuth, discoverAuthorizationServerMetadata, discoverOAuthServerInfo,
  extractWWWAuthenticateParams, type OAuthClientProvider, type OAuthDiscoveryState,
} from "@modelcontextprotocol/sdk/client/auth.js";
import { OAuthTokensSchema, type OAuthClientInformationMixed, type OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { encrypt, decrypt, isEncrypted } from "../utils/encrypt.js";
import { openExternal } from "../utils/open-external.js";
import type { MCPServerConfig } from "./types.js";

type OAuthOptions = Exclude<MCPServerConfig["oauth"], false | undefined>;

export class MCPOAuthError extends Error {}
export class MCPAuthenticationRequiredError extends MCPOAuthError {}
type Credentials = {
  tokens?: OAuthTokens; expiresAt?: number; client?: OAuthClientInformationMixed;
  discovery?: OAuthDiscoveryState; callbackPort?: number;
};
const locks = new Map<string, Promise<unknown>>();

async function exclusive<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve();
  const pending = previous.catch(() => {}).then(operation);
  locks.set(key, pending);
  try { return await pending; }
  finally { if (locks.get(key) === pending) locks.delete(key); }
}

function secureURL(value: string | URL): URL {
  const url = new URL(value);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.username || url.password || (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))) {
    throw new Error("MCP OAuth requires HTTPS (HTTP is allowed only on loopback), without URL credentials.");
  }
  return url;
}

function validateDiscovery(state: OAuthDiscoveryState, expectedIssuer?: string): void {
  const issuer = secureURL(state.authorizationServerUrl).href.replace(/\/$/, "");
  if (expectedIssuer && issuer !== secureURL(expectedIssuer).href.replace(/\/$/, "")) {
    throw new Error("MCP OAuth authorization server does not match the configured issuer.");
  }
  if (state.resourceMetadataUrl) secureURL(state.resourceMetadataUrl);
  for (const server of state.resourceMetadata?.authorization_servers ?? []) secureURL(server);
  const metadata = state.authorizationServerMetadata;
  if (metadata) {
    if (secureURL(metadata.issuer).href.replace(/\/$/, "") !== issuer) {
      throw new Error("MCP OAuth metadata issuer does not match its authorization server.");
    }
    for (const key of ["authorization_endpoint", "token_endpoint", "registration_endpoint"] as const) {
      if (metadata[key]) secureURL(metadata[key]);
    }
  }
}

/** SDK-backed OAuth for one remote MCP configuration. Credentials never cross configuration keys. */
export class MCPOAuth {
  private readonly options: OAuthOptions;
  private readonly file: string;
  private credentials: Credentials = {};
  private active = new Set<AbortController>();
  private generation = 0;

  constructor(private readonly name: string, private readonly config: MCPServerConfig,
    private readonly interactive: boolean = process.stdin.isTTY === true,
    private readonly onAuthorization?: (active: boolean) => void) {
    this.options = config.oauth || {};
    const identity = JSON.stringify({ name, url: config.url, issuer: this.options.issuer,
      clientId: this.options.clientId, scopes: this.options.scopes, callbackPort: this.options.callbackPort,
      headers: Object.entries(config.headers ?? {}).map(([key, value]) => [key.toLowerCase(), value]).sort(),
    });
    this.file = join(homedir(), ".agav", "mcp-auth", `${createHash("sha256").update(identity).digest("hex")}.json`);
  }

  private loginError(): Error {
    return new MCPAuthenticationRequiredError(`MCP server "${this.name}" requires OAuth login. Run: agav mcp auth ${this.name}`);
  }

  private async load(): Promise<void> {
    try {
      const content = await readFile(this.file, "utf8");
      if (!isEncrypted(content)) throw new Error("MCP OAuth credential file is not encrypted.");
      const stored: Credentials = JSON.parse(decrypt(content));
      if (!stored || typeof stored !== "object") throw new Error("Invalid MCP OAuth credentials.");
      if (stored.tokens) OAuthTokensSchema.parse(stored.tokens);
      if (stored.discovery) validateDiscovery(stored.discovery, this.options.issuer);
      this.credentials = stored;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") this.credentials = {};
      else throw error;
    }
  }

  private async save(): Promise<void> {
    const directory = join(homedir(), ".agav", "mcp-auth");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = `${this.file}.${randomBytes(12).toString("hex")}.tmp`;
    try {
      await writeFile(temporary, encrypt(JSON.stringify(this.credentials)), { mode: 0o600, flag: "wx" });
      await rename(temporary, this.file);
    } finally { await rm(temporary, { force: true }); }
  }

  private usable(): boolean {
    return !!this.credentials.tokens?.access_token &&
      (this.credentials.expiresAt === undefined || this.credentials.expiresAt > Date.now() + 30_000);
  }

  async fetch(url: string, init: RequestInit): Promise<Response> {
    const headers = new Headers(this.config.headers);
    new Headers(init.headers).forEach((value, key) => headers.set(key, value));
    if (!this.config.url || new URL(url).origin !== new URL(this.config.url).origin || new URL(url).username || new URL(url).password) {
      throw new Error("Refusing to send MCP credentials to a different origin or URL with credentials.");
    }
    // Never override or attempt OAuth for explicitly supplied authorization, regardless of casing.
    if (headers.has("authorization") || this.config.oauth === false) {
      return this.request(url, { ...init, headers });
    }
    await this.load();
    if (this.credentials.tokens && !this.usable()) await this.authenticate(false, init.signal ?? undefined);
    const attemptedToken = this.credentials.tokens?.access_token;
    if (attemptedToken) { secureURL(url); headers.set("authorization", `Bearer ${attemptedToken}`); }
    const response = await this.request(url, { ...init, headers });
    if (response.status !== 401) return response;
    const authenticateHeader = response.headers.get("www-authenticate");
    if (authenticateHeader && !/\bbearer\b/i.test(authenticateHeader)) return response;
    const challenge = extractWWWAuthenticateParams(response);
    await response.body?.cancel();
    await this.authenticate(false, init.signal ?? undefined, challenge.resourceMetadataUrl,
      this.options.scopes?.join(" ") || challenge.scope, attemptedToken);
    headers.set("authorization", `Bearer ${this.credentials.tokens!.access_token}`);
    // Exactly one authenticated replay; a second 401 is returned to the caller.
    return this.request(url, { ...init, headers });
  }

  private async request(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const signal = init.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal;
    const timer = setTimeout(() => controller.abort(new Error("MCP connection timed out.")), 30_000);
    try { return await globalThis.fetch(url, { ...init, signal, redirect: "error" }); }
    finally { clearTimeout(timer); } // Do not impose a lifetime limit on a healthy SSE stream.
  }

  /** Explicit login is interactive even when invoked from a non-TTY CLI. */
  async auth(signal?: AbortSignal): Promise<void> {
    if (this.config.oauth === false) throw new Error(`OAuth is disabled for MCP server "${this.name}".`);
    await this.authenticate(true, signal);
  }

  private async authenticate(interactive: boolean, signal?: AbortSignal, resourceMetadataUrl?: URL,
    scope?: string, rejectedToken?: string): Promise<void> {
    try {
      await this.authenticateInner(interactive, signal, resourceMetadataUrl, scope, rejectedToken);
    } catch (error) {
      if (error instanceof MCPAuthenticationRequiredError) throw error;
      throw new MCPOAuthError(error instanceof Error ? error.message : String(error), { cause: error });
    }
  }

  private async authenticateInner(interactive: boolean, signal?: AbortSignal, resourceMetadataUrl?: URL,
    scope?: string, rejectedToken?: string): Promise<void> {
    const generation = this.generation;
    await exclusive(this.file, async () => {
      signal?.throwIfAborted();
      if (generation !== this.generation) throw new Error("MCP OAuth disconnected.");
      await this.load();
      if (this.usable() && (rejectedToken === undefined || this.credentials.tokens?.access_token !== rejectedToken)) return;
      if (!interactive && !this.credentials.tokens?.refresh_token) throw this.loginError();
      if (!this.config.url) throw new Error("MCP OAuth requires a remote server URL.");
      secureURL(this.config.url);
      if (resourceMetadataUrl) secureURL(resourceMetadataUrl);
      const seconds = this.options.timeoutSeconds ?? 300;
      if (!Number.isFinite(seconds) || seconds <= 0) throw new Error("MCP OAuth timeoutSeconds must be positive.");
      signal?.throwIfAborted();
      if (generation !== this.generation) throw new Error("MCP OAuth disconnected.");
      const controller = new AbortController();
      this.active.add(controller);
      const abort = () => controller.abort(signal?.reason);
      signal?.addEventListener("abort", abort, { once: true });
      const timer = setTimeout(() => controller.abort(new Error("MCP OAuth login timed out.")), seconds * 1000);
      let server: Server | undefined;
      let verifier = "";
      const state = randomBytes(32).toString("base64url");
      let resolveCode!: (code: string) => void;
      let rejectCode!: (error: Error) => void;
      const code = new Promise<string>((resolve, reject) => { resolveCode = resolve; rejectCode = reject; });
      // Callback can abort while discovery or browser opening is still in flight.
      void code.catch(() => {});
      const cancelled = () => { rejectCode(controller.signal.reason); server?.closeAllConnections(); server?.close(); };
      controller.signal.addEventListener("abort", cancelled, { once: true });
      this.onAuthorization?.(true);
      try {
        const fetchFn: typeof globalThis.fetch = async (input, init) => {
          const target = input instanceof Request ? input.url : String(input);
          secureURL(target);
          const response = await globalThis.fetch(input, { ...init, signal: controller.signal, redirect: "error" });
          if (!response.ok && init?.method === "POST") {
            // Keep structured OAuth errors intact: the SDK uses invalid_grant/client to
            // invalidate credentials. A plain-text denial is not an OAuth JSON error.
            const error = await response.clone().json().catch(() => undefined) as { error?: unknown } | undefined;
            const endpoint = secureURL(target);
            const metadata = this.credentials.discovery?.authorizationServerMetadata;
            const registration = metadata?.registration_endpoint === endpoint.href;
            if ((registration && response.status === 403) || typeof error?.error !== "string") {
              await response.body?.cancel();
              const location = `${endpoint.origin}${endpoint.pathname}`; // No query strings or response-body secrets.
              if (registration && response.status === 403) {
                const advice = endpoint.hostname === "api.figma.com" && endpoint.pathname === "/v1/oauth/mcp/register"
                  ? " Figma rejected Agav's client registration; remote access may require Figma client approval. Use Figma's desktop MCP server if available."
                  : " The server refused dynamic registration; contact its administrator for client approval or a supported pre-registered client.";
                throw new Error(`OAuth client registration denied (HTTP 403) at ${location}.${advice}`);
              }
              throw new Error(`OAuth ${registration ? "client registration" : "token request"} failed (HTTP ${response.status}) at ${location}. The server did not return a structured OAuth error.`);
            }
          }
          // Validate discovered endpoints before the SDK can register or exchange credentials.
          if (response.ok && (!init?.method || init.method === "GET")) {
            const data = await response.clone().json().catch(() => undefined) as Record<string, unknown> | undefined;
            if (data) {
              for (const key of ["issuer", "authorization_endpoint", "token_endpoint", "registration_endpoint"]) {
                if (typeof data[key] === "string") secureURL(data[key]);
              }
              if (Array.isArray(data.authorization_servers)) for (const issuer of data.authorization_servers) secureURL(String(issuer));
            }
          }
          return response;
        };
        let discovery = this.credentials.discovery;
        if (resourceMetadataUrl && discovery?.resourceMetadataUrl && resourceMetadataUrl.href !== discovery.resourceMetadataUrl) {
          discovery = undefined;
        }
        if (!discovery) {
          discovery = this.options.issuer
            ? { authorizationServerUrl: this.options.issuer,
                authorizationServerMetadata: await discoverAuthorizationServerMetadata(this.options.issuer, { fetchFn }) }
            : await discoverOAuthServerInfo(this.config.url, { resourceMetadataUrl, fetchFn });
          validateDiscovery(discovery, this.options.issuer);
          this.credentials.discovery = discovery;
        }
        const port = this.options.callbackPort || this.credentials.callbackPort || 0;
        if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Invalid MCP OAuth callback port.");
        const startCallback = async () => {
          if (server) return;
          server = createServer((request, response) => {
            const callback = new URL(request.url ?? "/", "http://127.0.0.1");
            const supplied = callback.searchParams.get("state") ?? "";
            const validState = Buffer.byteLength(supplied) === Buffer.byteLength(state) &&
              timingSafeEqual(Buffer.from(supplied), Buffer.from(state));
            if (request.method !== "GET" || callback.pathname !== "/callback" || !validState ||
                callback.searchParams.getAll("state").length !== 1) {
              response.writeHead(400).end("Invalid OAuth callback."); return;
            }
            const issuer = callback.searchParams.get("iss");
            if ((issuer !== null && (callback.searchParams.getAll("iss").length !== 1 || issuer !== discovery!.authorizationServerUrl)) ||
                ((discovery!.authorizationServerMetadata as { authorization_response_iss_parameter_supported?: boolean } | undefined)?.authorization_response_iss_parameter_supported && issuer === null)) {
              response.writeHead(400).end("Invalid OAuth issuer.");
              rejectCode(new Error("MCP OAuth callback issuer mismatch.")); return;
            }
            if (callback.searchParams.has("error")) {
              response.writeHead(400).end("Authorization denied.");
              rejectCode(new Error("MCP OAuth authorization was denied.")); return;
            }
            const value = callback.searchParams.get("code");
            if (!value || callback.searchParams.getAll("code").length !== 1) {
              response.writeHead(400).end("Missing authorization code."); return;
            }
            response.writeHead(200, { "content-type": "text/plain", "cache-control": "no-store" }).end("Authorized. You can close this window.");
            resolveCode(value);
          });
          await new Promise<void>((resolve, reject) => {
            server!.once("error", (error: NodeJS.ErrnoException) => {
              if (error.code !== "EADDRINUSE") { reject(error); return; }
              // A saved registration is bound to this redirect URI. Never silently
              // pick a different port while reusing its client credentials.
              const recovery = this.options.callbackPort
                ? "Stop the process using that port, or change oauth.callbackPort to a free port and authenticate again."
                : `Stop the process using that port and retry, or run agav mcp logout ${this.name} then agav mcp auth ${this.name} to register a new callback port.`;
              reject(new Error(`MCP OAuth callback port ${port} is already in use. ${recovery}`, { cause: error }));
            });
            server!.listen(port, "127.0.0.1", resolve);
          });
          controller.signal.throwIfAborted();
          const address = server.address();
          if (!address || typeof address === "string") throw new Error("Cannot bind MCP OAuth callback.");
          this.credentials.callbackPort = address.port;
        };
        // Refresh does not require binding a port. First-time registration needs a stable redirect URI.
        if (!port) await startCallback();
        const redirectUrl = `http://127.0.0.1:${this.credentials.callbackPort ?? port}/callback`;
        const methods = discovery.authorizationServerMetadata?.token_endpoint_auth_methods_supported ?? ["client_secret_basic"];
        const authMethod = methods.includes("none") ? "none" : methods.includes("client_secret_basic") ? "client_secret_basic" :
          methods.includes("client_secret_post") ? "client_secret_post" : undefined;
        if (!authMethod) throw new Error("MCP OAuth server has no supported client authentication method.");
        const provider: OAuthClientProvider = {
          redirectUrl,
          clientMetadata: { client_name: "agav", redirect_uris: [redirectUrl],
            grant_types: ["authorization_code", "refresh_token"], response_types: ["code"],
            token_endpoint_auth_method: authMethod, scope: this.options.scopes?.join(" ") },
          state: () => state,
          clientInformation: () => this.options.clientId
            ? { client_id: this.options.clientId, issuer: discovery!.authorizationServerUrl }
            : this.credentials.client,
          saveClientInformation: async (client) => { this.credentials.client = client; await this.save(); },
          tokens: () => this.credentials.tokens,
          saveTokens: async (tokens) => {
            this.credentials.tokens = tokens;
            this.credentials.expiresAt = tokens.expires_in === undefined ? undefined : Date.now() + tokens.expires_in * 1000;
            await this.save();
          },
          saveCodeVerifier: (value) => { verifier = value; },
          codeVerifier: () => verifier,
          discoveryState: () => discovery,
          saveDiscoveryState: async (value) => {
            validateDiscovery(value, this.options.issuer);
            discovery = value;
            this.credentials.discovery = value;
            await this.save();
          },
          redirectToAuthorization: async (url) => {
            if (!interactive) throw this.loginError();
            secureURL(url);
            await startCallback();
            process.stderr.write(`[mcp:${this.name}] Opening your browser for OAuth sign-in.\n`);
            if (!await openExternal(url.href)) {
              throw new Error(`Cannot open the browser. Run agav mcp auth ${this.name} in a desktop session.`);
            }
          },
          invalidateCredentials: async (part) => {
            if (part === "all" || part === "tokens") { delete this.credentials.tokens; delete this.credentials.expiresAt; }
            if (part === "all" || part === "client") delete this.credentials.client;
            if (part === "all" || part === "verifier") verifier = "";
            await this.save();
          },
        };
        const options = { serverUrl: this.config.url, scope: scope || this.options.scopes?.join(" "), resourceMetadataUrl, fetchFn };
        if (await sdkAuth(provider, options) === "REDIRECT") {
          const authorizationCode = await code;
          controller.signal.throwIfAborted();
          await sdkAuth(provider, { ...options, authorizationCode });
        }
      } finally {
        this.onAuthorization?.(false);
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        controller.signal.removeEventListener("abort", cancelled);
        this.active.delete(controller);
        if (server) { server.closeAllConnections(); await new Promise<void>((resolve) => server!.close(() => resolve())); }
      }
    });
  }

  async disconnect(): Promise<void> {
    this.generation++;
    for (const controller of this.active) controller.abort(new Error("MCP OAuth disconnected."));
    await exclusive(this.file, async () => { this.credentials = {}; await rm(this.file, { force: true }); });
  }
}
