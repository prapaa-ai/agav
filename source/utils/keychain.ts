/**
 * OS credential-store integration.
 *
 * API keys are secrets. Writing them into ~/.agav/config.json — even
 * AES-encrypted — leaves them recoverable by anyone who can read the file and
 * the binary, because the encryption key is derived from non-secret material
 * (see utils/encrypt.ts). Preferring the operating system's credential store
 * keeps the secret outside the config file entirely, under the OS's access
 * control (Keychain ACLs, the login keyring, DPAPI).
 *
 * We deliberately shell out to the platform's built-in credential tooling
 * rather than adding a native module (keytar et al.): Agav ships as a single
 * binary with no native dependencies, and a native add-on would break that.
 *
 *   - macOS   : `security` (always present)
 *   - Linux   : `secret-tool` (libsecret; present on most desktop installs)
 *   - Windows : PowerShell + the Windows Credential Manager (DPAPI-protected)
 *
 * Every entry is namespaced under a fixed service so Agav never reads or writes
 * unrelated credentials. When no store is available — a headless Linux box with
 * no libsecret, say — the caller falls back to the encrypted config file.
 *
 * All calls are best-effort and never throw: a credential-store failure must
 * degrade to the file fallback, not crash startup or a key save.
 *
 * Secret transport keeps the plaintext off the process command line on every
 * platform: macOS feeds `security` commands over stdin (interactive `-i` mode),
 * Linux feeds `secret-tool` the secret on stdin, and Windows passes it through
 * an environment variable to PowerShell. Values are base64-wrapped where the
 * store's text handling is otherwise lossy (macOS `-w` hex-encodes any value
 * with a non-printable byte).
 */

import { execFile } from "node:child_process";
import { platform } from "node:os";
import { join } from "node:path";

/** Fixed service/namespace for every Agav credential-store entry. */
const SERVICE = "agav-cli";

/**
 * Placeholder written into config.json in place of a secret when the value
 * lives in the OS credential store. `loadConfig` resolves it back to the real
 * secret via `getSecret`. Distinct from the "enc:" prefix used by the file
 * fallback so the two storage modes never collide.
 */
const KEYCHAIN_PREFIX = "keychain:";

/**
 * Default per-call subprocess timeout. Credential-store tooling is normally
 * instant; a longer wait means the store is locked/unresponsive, in which case
 * degrading to the file fallback quickly beats stalling startup.
 */
const CALL_TIMEOUT_MS = 5000;

/** True when `value` is a credential-store placeholder rather than a secret. */
export function isKeychainRef(value: string): boolean {
  return value.startsWith(KEYCHAIN_PREFIX);
}

/** Build the placeholder stored in config.json for `account`. */
export function keychainRef(account: string): string {
  return KEYCHAIN_PREFIX + account;
}

/** Extract the account name from a placeholder; "" when it is not one. */
export function keychainAccount(value: string): string {
  return isKeychainRef(value) ? value.slice(KEYCHAIN_PREFIX.length) : "";
}

interface RunOptions {
  /** Fed to the child's stdin, then the stream is closed. */
  input?: string;
  /** Extra environment entries merged onto process.env for this call. */
  env?: Record<string, string>;
}

/**
 * Circuit breaker: once any call hits its timeout we treat the store as
 * unresponsive for the rest of the process and fast-fail subsequent calls.
 * Without this, resolving N configured keys against a locked/hung store would
 * serialize N full timeouts (e.g. 7 × 5s ≈ 35s) onto startup. One timeout is
 * enough evidence to stop; the file fallback / missing-key path takes over.
 */
let storeUnresponsive = false;

/** Reset the circuit breaker (tests only). */
export function __resetKeychainBreakerForTests(): void {
  storeUnresponsive = false;
}

/**
 * Run a command with no shell, resolving { code, stdout } and never rejecting.
 * A spawn failure (missing tool), a non-zero exit, a timeout, and an stdin pipe
 * error (EPIPE when the child closes its input early) all resolve to a non-zero
 * code rather than throwing — the whole module's "never throw" contract depends
 * on this. A timeout additionally trips the circuit breaker.
 */
function run(file: string, args: string[], options: RunOptions = {}): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (code: number, stdout: string) => {
      if (settled) return;
      settled = true;
      resolve({ code, stdout });
    };
    try {
      const child = execFile(
        file,
        args,
        {
          timeout: CALL_TIMEOUT_MS,
          maxBuffer: 1024 * 1024,
          windowsHide: true,
          env: options.env ? { ...process.env, ...options.env } : process.env,
        },
        (error, stdout) => {
          if (error) {
            // execFile marks a timeout-killed child with `killed: true`; trip the
            // breaker so we never pay another full timeout this process.
            if ((error as { killed?: boolean }).killed) storeUnresponsive = true;
            const code = typeof (error as NodeJS.ErrnoException & { code?: number }).code === "number"
              ? (error as unknown as { code: number }).code
              : 1;
            done(code, stdout ?? "");
            return;
          }
          done(0, stdout ?? "");
        },
      );
      child.on("error", () => done(1, ""));
      if (options.input !== undefined) {
        // The error listener must be on the stdin STREAM, not the child: a child
        // that closes its input early surfaces EPIPE on child.stdin, and an
        // unhandled 'error' there would crash the process despite the try/catch
        // (it fires asynchronously). Swallow it — the exit code reports failure.
        const stdin = child.stdin;
        if (stdin) {
          stdin.on("error", () => done(1, ""));
          stdin.end(options.input);
        }
      }
    } catch {
      done(1, "");
    }
  });
}

type Backend = "macos" | "secret-tool" | "windows" | "none";

let cachedBackend: Backend | undefined;

/**
 * Absolute path to the system Windows PowerShell. Resolving it from SystemRoot
 * (never the bare name "powershell") prevents executing a repository-local
 * powershell.exe that libuv's CWD-first search would otherwise prefer — which
 * would run attacker code during credential-store detection, before any tool
 * permission gate. Falls back to the conventional location if SystemRoot is
 * unset.
 */
function windowsPowerShellPath(): string {
  const systemRoot = process.env.SystemRoot || process.env.windir || "C:\\Windows";
  return join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

/** Detect the usable credential-store backend for this platform, once. */
async function detectBackend(): Promise<Backend> {
  if (cachedBackend !== undefined) return cachedBackend;
  const os = platform();
  if (os === "darwin") {
    // `security help` confirms the tool is callable; it ships with macOS.
    const { code } = await run("security", ["help"]);
    cachedBackend = code === 0 ? "macos" : "none";
  } else if (os === "linux") {
    // `secret-tool` has NO --version/--help subcommand: an unknown first word
    // prints usage and exits non-zero, so the old `--version` probe always
    // reported "no store" and keys never migrated. Probe instead with a real,
    // read-only `search` for an attribute that cannot match anything. On a
    // reachable Secret Service that succeeds and exits 0 (an empty result is
    // still a successful search), proving the tool runs and the keyring daemon
    // is up. A missing binary (spawn failure) or an unreachable service exits
    // non-zero, which we treat as "no store" so the caller uses the file
    // fallback. The probe neither creates nor reads any real item.
    const probe = await run("secret-tool", ["search", "service", `${SERVICE}:__agav_probe__`]);
    cachedBackend = probe.code === 0 ? "secret-tool" : "none";
  } else if (os === "win32") {
    const { code } = await run(windowsPowerShellPath(), [
      "-NoProfile", "-NonInteractive", "-Command", "exit 0",
    ]);
    cachedBackend = code === 0 ? "windows" : "none";
  } else {
    cachedBackend = "none";
  }
  return cachedBackend;
}

/** Reset the cached backend detection (tests only). */
export function __resetKeychainBackendForTests(): void {
  cachedBackend = undefined;
}

/** True when an OS credential store is available to prefer over the config file. */
export async function isKeychainAvailable(): Promise<boolean> {
  return (await detectBackend()) !== "none";
}

/** Quote a token for `security`'s interactive (`-i`) line parser. */
function securityQuote(value: string): string {
  // The interactive tokenizer understands double-quoted strings with backslash
  // escaping; escaping backslash and double-quote covers every byte safely.
  return '"' + value.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
}

/**
 * Store `secret` under `account` in the OS credential store. Returns true on
 * success. Overwrites any existing entry for the same account so re-saving a
 * rotated key does not accumulate duplicates. Never throws.
 */
export async function setSecret(account: string, secret: string): Promise<boolean> {
  if (!account || !secret) return false;
  if (storeUnresponsive) return false;
  const backend = await detectBackend();
  switch (backend) {
    case "macos": {
      // Feed the command over stdin via interactive mode (`security -i`) so the
      // secret never appears in this process's argv (where EDR/`ps` could read
      // it). Store base64 so retrieval with `-w` returns the value verbatim —
      // `-w` hex-encodes any value containing a non-printable byte, which would
      // otherwise corrupt the round-trip.
      const encoded = Buffer.from(secret, "utf-8").toString("base64");
      const line = [
        "add-generic-password",
        "-U",
        "-s", securityQuote(SERVICE),
        "-a", securityQuote(account),
        "-w", securityQuote(encoded),
      ].join(" ") + "\n";
      const { code } = await run("security", ["-i"], { input: line });
      return code === 0;
    }
    case "secret-tool": {
      // secret-tool reads the secret from stdin, so it never appears in argv.
      const { code } = await run(
        "secret-tool",
        ["store", "--label", `${SERVICE}: ${account}`, "service", SERVICE, "account", account],
        { input: secret },
      );
      return code === 0;
    }
    case "windows": {
      // DPAPI-protect the secret and store the base64 blob in Credential
      // Manager. The plaintext is passed through an env var, never argv. The
      // native cmdkey exit status propagates: PowerShell's -Command returns 1
      // when the final statement's success ($?) is false, so a cmdkey failure
      // is reported as a failed store (the caller then keeps the file value).
      const target = `${SERVICE}:${account}`;
      const script =
        "$ErrorActionPreference='Stop';" +
        "Add-Type -AssemblyName System.Security;" +
        "$b=[Text.Encoding]::UTF8.GetBytes($env:AGAV_KC_SECRET);" +
        "$p=[Security.Cryptography.ProtectedData]::Protect($b,$null,'CurrentUser');" +
        "$enc=[Convert]::ToBase64String($p);" +
        `cmdkey /generic:${psQuote(target)} /user:${psQuote(SERVICE)} /pass:$enc | Out-Null;` +
        // Make the native exit status authoritative so a cmdkey failure is not
        // masked by the piped Out-Null.
        "if($LASTEXITCODE -ne 0){exit 1}";
      const { code } = await runWindows(script, secret);
      return code === 0;
    }
    default:
      return false;
  }
}

/**
 * Retrieve the secret stored under `account`, or undefined when absent or no
 * store is available. Never throws.
 */
export async function getSecret(account: string): Promise<string | undefined> {
  if (!account) return undefined;
  if (storeUnresponsive) return undefined;
  const backend = await detectBackend();
  switch (backend) {
    case "macos": {
      // Read the base64 blob written by setSecret and decode it. Run via `-i`
      // so the account name is not on argv either, matching the write path.
      const line = [
        "find-generic-password",
        "-s", securityQuote(SERVICE),
        "-a", securityQuote(account),
        "-w",
      ].join(" ") + "\n";
      const { code, stdout } = await run("security", ["-i"], { input: line });
      if (code !== 0) return undefined;
      const encoded = stdout.replace(/\r?\n$/, "");
      if (!encoded.length) return undefined;
      try {
        const decoded = Buffer.from(encoded, "base64").toString("utf-8");
        return decoded.length ? decoded : undefined;
      } catch {
        return undefined;
      }
    }
    case "secret-tool": {
      const { code, stdout } = await run("secret-tool", [
        "lookup", "service", SERVICE, "account", account,
      ]);
      // secret-tool emits the secret with no trailing newline on success.
      if (code !== 0) return undefined;
      return stdout.length ? stdout : undefined;
    }
    case "windows": {
      const target = `${SERVICE}:${account}`;
      const script =
        "$ErrorActionPreference='Stop';" +
        "Add-Type -AssemblyName System.Security;" +
        "$sig=@'\n" +
        "using System;using System.Runtime.InteropServices;using System.Text;\n" +
        "public class Cred{[DllImport(\"advapi32\",CharSet=CharSet.Unicode,SetLastError=true)]public static extern bool CredRead(string t,int ty,int f,out IntPtr c);[DllImport(\"advapi32\")]public static extern void CredFree(IntPtr c);[StructLayout(LayoutKind.Sequential)]public struct CREDENTIAL{public int Flags;public int Type;public IntPtr TargetName;public IntPtr Comment;public long LastWritten;public int CredentialBlobSize;public IntPtr CredentialBlob;public int Persist;public int AttributeCount;public IntPtr Attributes;public IntPtr TargetAlias;public IntPtr UserName;}}\n" +
        "'@;" +
        "Add-Type $sig;" +
        "$ptr=[IntPtr]::Zero;" +
        `if(-not [Cred]::CredRead(${psQuote(target)},1,0,[ref]$ptr)){exit 1};` +
        "$c=[Runtime.InteropServices.Marshal]::PtrToStructure($ptr,[Type][Cred+CREDENTIAL]);" +
        "$bytes=New-Object byte[] $c.CredentialBlobSize;" +
        "[Runtime.InteropServices.Marshal]::Copy($c.CredentialBlob,$bytes,0,$c.CredentialBlobSize);" +
        "[Cred]::CredFree($ptr);" +
        "$enc=[Text.Encoding]::Unicode.GetString($bytes);" +
        "$p=[Convert]::FromBase64String($enc);" +
        "$u=[Security.Cryptography.ProtectedData]::Unprotect($p,$null,'CurrentUser');" +
        "[Console]::Out.Write([Text.Encoding]::UTF8.GetString($u));";
      const { code, stdout } = await runWindows(script);
      if (code !== 0) return undefined;
      return stdout.length ? stdout : undefined;
    }
    default:
      return undefined;
  }
}

/** Delete the credential stored under `account`. Idempotent; never throws. */
export async function deleteSecret(account: string): Promise<void> {
  if (!account) return;
  if (storeUnresponsive) return;
  const backend = await detectBackend();
  switch (backend) {
    case "macos": {
      const line = [
        "delete-generic-password",
        "-s", securityQuote(SERVICE),
        "-a", securityQuote(account),
      ].join(" ") + "\n";
      await run("security", ["-i"], { input: line });
      return;
    }
    case "secret-tool":
      await run("secret-tool", ["clear", "service", SERVICE, "account", account]);
      return;
    case "windows": {
      const target = `${SERVICE}:${account}`;
      await runWindows(`cmdkey /delete:${psQuote(target)} | Out-Null`);
      return;
    }
    default:
      return;
  }
}

/** Single-quote a string for safe embedding in a PowerShell literal. */
function psQuote(value: string): string {
  return "'" + value.replace(/'/g, "''") + "'";
}

/** Run a PowerShell script, passing any secret through an env var, not argv. */
function runWindows(script: string, secret?: string): Promise<{ code: number; stdout: string }> {
  return run(
    windowsPowerShellPath(),
    ["-NoProfile", "-NonInteractive", "-Command", script],
    secret === undefined ? {} : { env: { AGAV_KC_SECRET: secret } },
  );
}
