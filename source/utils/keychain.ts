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

import { spawn } from "node:child_process";
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
  /** True for a getSecret read: a timeout then also trips the read breaker. */
  isRead?: boolean;
}

/**
 * Circuit breakers that fast-fail further calls once the store proves
 * unresponsive, so a locked/hung store never serializes N full timeouts onto
 * startup. They are intentionally SPLIT:
 *
 *   - `writeBreaker` trips on ANY timeout (detection, write, or read) and blocks
 *     further WRITES. Writes have a safe fallback (encrypt into the config file),
 *     so giving up early is correct.
 *
 *   - `readBreaker` trips ONLY on a READ (getSecret) timeout and blocks further
 *     reads. A read has NO fallback — the plaintext lives only in the store — so a
 *     detection or write timeout must NOT disable reads: that was the regression
 *     where one slow write during startup migration made every migrated key
 *     (e.g. the OpenAI key) silently unresolvable, so `/model` showed no OpenAI
 *     models. Each read still has its own per-call deadline, so the worst case is
 *     bounded by the (small) number of migrated keys, and a genuinely hung store
 *     still trips the read breaker after the first read timeout.
 */
let writeBreaker = false;
let readBreaker = false;

/**
 * True once a WRITE-affecting timeout occurred this process; the migration uses
 * it to avoid committing a `keychain:` placeholder it could no longer write
 * reliably. (Reads are governed separately so a working key is never dropped.)
 */
export function isStoreUnresponsive(): boolean {
  return writeBreaker;
}

/** Reset the circuit breakers (tests only). */
export function __resetKeychainBreakerForTests(): void {
  writeBreaker = false;
  readBreaker = false;
}

/** How long after SIGTERM we wait before escalating to SIGKILL. */
const KILL_GRACE_MS = 500;

/** Max bytes of stdout we keep; credential blobs are tiny, so this is generous. */
const MAX_STDOUT = 1024 * 1024;

/**
 * Run a command with no shell, resolving { code, stdout } and never rejecting.
 * A spawn failure (missing tool), a non-zero exit, a timeout, and an stdin pipe
 * error (EPIPE when the child closes its input early) all resolve to a non-zero
 * code rather than throwing — the whole module's "never throw" contract depends
 * on this.
 *
 * The deadline is enforced by OUR OWN timer, independent of the child: at the
 * deadline we resolve as failure (code 1) AND trip the circuit breaker
 * immediately — we never trust the child's exit status for a timed-out call. A
 * child that catches SIGTERM and exits 0, or ignores SIGTERM entirely, can
 * neither masquerade as success nor hang the caller: after the timeout we send
 * SIGTERM, then SIGKILL after a short grace period, and the promise is already
 * settled either way. This is why we use spawn (full signal control) rather than
 * execFile (whose own `timeout` only sends one signal and reports via the exit
 * callback, which a well-behaved-on-SIGTERM child can defeat).
 */
function run(file: string, args: string[], options: RunOptions = {}): Promise<{ code: number; stdout: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    const chunks: Buffer[] = [];
    let total = 0;
    let deadline: NodeJS.Timeout | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    let child: ReturnType<typeof spawn> | undefined;
    // An stdin delivery failure (EPIPE: the child closed its input before
    // consuming all of it) must make the whole call fail, independent of the exit
    // code — a store command that didn't receive its full secret may still exit 0.
    let stdinFailed = false;

    // Resolving the promise does NOT cancel the SIGKILL escalation: once the
    // deadline fires we must still force-kill a child that ignores SIGTERM, even
    // though the caller has already moved on. `done` therefore only clears the
    // deadline; the killTimer is cleared separately on a clean close.
    const done = (code: number) => {
      if (settled) return;
      settled = true;
      if (deadline) clearTimeout(deadline);
      // Decode the whole stdout ONCE, after all chunks are in: decoding each
      // chunk independently would mangle a multi-byte UTF-8 character split
      // across a chunk boundary (Linux/Windows return raw text, not base64).
      resolve({ code, stdout: Buffer.concat(chunks).toString("utf-8"), timedOut });
    };

    try {
      child = spawn(file, args, {
        windowsHide: true,
        env: options.env ? { ...process.env, ...options.env } : process.env,
        stdio: ["pipe", "pipe", "ignore"],
      });

      // Independent deadline: settle as failure and force-terminate the child
      // regardless of how it responds to signals. Tripping the breaker here
      // (not in an exit callback) guarantees it fires even for a hung child.
      deadline = setTimeout(() => {
        timedOut = true;
        // Any timeout blocks further writes (they have a file fallback); a read
        // timeout additionally blocks further reads (no fallback — but we never
        // let a non-read timeout disable reads, so a working key is not dropped).
        writeBreaker = true;
        if (options.isRead) readBreaker = true;
        try { child?.kill("SIGTERM"); } catch { /* ignore */ }
        killTimer = setTimeout(() => {
          try { child?.kill("SIGKILL"); } catch { /* ignore */ }
        }, KILL_GRACE_MS);
        done(1);
      }, CALL_TIMEOUT_MS);

      child.stdout?.on("data", (chunk: Buffer) => {
        if (total >= MAX_STDOUT) return;
        total += chunk.length;
        chunks.push(chunk);
      });
      // Swallow stdout stream errors (e.g. after a kill) rather than crashing.
      child.stdout?.on("error", () => {});

      child.on("error", () => { if (killTimer) clearTimeout(killTimer); done(1); }); // spawn failure
      child.on("close", (code, signal) => {
        // The child is gone; no need to escalate a kill.
        if (killTimer) clearTimeout(killTimer);
        // A signal-terminated child (our kill, or external) is a failure even if
        // the exit code slot is null; never report success for it. An stdin
        // delivery failure is also authoritative: a command that did not receive
        // its full input must not be reported successful on a 0 exit.
        if (signal || stdinFailed) { done(1); return; }
        done(code === 0 ? 0 : (code ?? 1));
      });

      if (options.input !== undefined) {
        const stdin = child.stdin;
        if (stdin) {
          // The error listener must be on the stdin STREAM, not the child: a
          // child that closes its input early surfaces EPIPE on child.stdin, and
          // an unhandled 'error' there would crash the process (it fires
          // asynchronously, outside the try/catch). Record it so the close
          // handler reports failure, then settle defensively.
          stdin.on("error", () => { stdinFailed = true; done(1); });
          stdin.end(options.input);
        }
      } else {
        child.stdin?.end();
      }
    } catch {
      done(1);
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

/**
 * Detect the usable credential-store backend for this platform, caching the
 * result. A detection result is cached ONLY when it is definitive: a success
 * (the real backend) or a genuine non-zero/absent result (→ "none"). A detection
 * that TIMED OUT is NOT cached — it is transient (the store was momentarily
 * locked/slow), and caching "none" would disable reads for the whole session,
 * silently dropping an already-migrated key. An uncached timeout returns "none"
 * for this call but lets a later call retry (bounded by its own deadline and the
 * read breaker, which only trips on a read timeout).
 */
async function detectBackend(): Promise<Backend> {
  if (cachedBackend !== undefined) return cachedBackend;
  const os = platform();

  let probe: { code: number; timedOut: boolean };
  if (os === "darwin") {
    // `security help` confirms the tool is callable; it ships with macOS.
    probe = await run("security", ["help"]);
    if (probe.code === 0) return (cachedBackend = "macos");
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
    probe = await run("secret-tool", ["search", "service", `${SERVICE}:__agav_probe__`]);
    if (probe.code === 0) return (cachedBackend = "secret-tool");
  } else if (os === "win32") {
    probe = await run(windowsPowerShellPath(), ["-NoProfile", "-NonInteractive", "-Command", "exit 0"]);
    if (probe.code === 0) return (cachedBackend = "windows");
  } else {
    return (cachedBackend = "none");
  }

  // Probe failed. A timeout is transient — do NOT cache it, so a later call can
  // retry once the store recovers. A definitive failure (missing tool /
  // unreachable service) is cached as "none".
  if (probe.timedOut) return "none";
  return (cachedBackend = "none");
}

/** Reset the cached backend detection (tests only). */
export function __resetKeychainBackendForTests(): void {
  cachedBackend = undefined;
}

/** True when an OS credential store is available to prefer over the config file. */
export async function isKeychainAvailable(): Promise<boolean> {
  return (await detectBackend()) !== "none";
}

/**
 * Reject a token that cannot be safely carried to a credential-store helper.
 * The macOS interactive parser (`security -i`) splits its input into separate
 * commands at a newline BEFORE it applies quoting, so a newline embedded in an
 * account or service would inject an extra `security` command and could flip the
 * final exit status. A NUL likewise terminates C-string arguments. We refuse any
 * control character in the account/service used to build a command, returning a
 * failure to the caller (which falls back to file encryption) rather than
 * emitting a dangerous line. Agav's own account names are fixed, printable
 * constants, so this only ever rejects a maliciously crafted keychain: reference.
 */
function isSafeToken(value: string): boolean {
  // eslint-disable-next-line no-control-regex
  return !/[\u0000-\u001f\u007f]/.test(value);
}

/** Quote a token for `security`'s interactive (`-i`) line parser. */
function securityQuote(value: string): string {
  // The interactive tokenizer understands double-quoted strings with backslash
  // escaping; escaping backslash and double-quote covers printable bytes safely.
  // Control characters (esp. newline) are rejected upstream by isSafeToken — the
  // parser would act on them BEFORE quoting, so quoting alone cannot contain them.
  return '"' + value.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
}

/**
 * Apple's interactive `security` reads its command line into a fixed 4096-byte
 * buffer (≤4095 usable bytes per line). A longer line is silently split, and the
 * trailing fragment becomes a second, empty, SUCCESSFUL command that would mask
 * the real command's failure. We refuse to emit any line at/above this bound so a
 * store can never be falsely reported successful; the caller then falls back to
 * in-file encryption. Normal API keys are far below this limit even after base64.
 */
const SECURITY_LINE_LIMIT = 4095;

/**
 * Store `secret` under `account` in the OS credential store. Returns true on
 * success. Overwrites any existing entry for the same account so re-saving a
 * rotated key does not accumulate duplicates. Never throws.
 */
export async function setSecret(account: string, secret: string): Promise<boolean> {
  if (!account || !secret) return false;
  // A control character in the account would be a command-injection vector for
  // the macOS interactive parser; refuse and let the caller use the file fallback.
  if (!isSafeToken(account)) return false;
  if (writeBreaker) return false;
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
        // Trust /usr/bin/security to read this item back without a GUI prompt.
        // Without an explicit -T, `-U` resets the item's ACL to trust ONLY the
        // creating process instance, so a LATER `security` read (e.g. loadConfig
        // in the TUI) can trigger an "allow access?" dialog that a raw-mode
        // terminal cannot answer — the read then hangs, hits our timeout, trips
        // the breaker, and the key silently disappears (e.g. /model shows no
        // OpenAI models). Since every read/write here goes through
        // /usr/bin/security, trusting exactly that binary is both prompt-free and
        // minimal (NOT `-A`, which Apple flags as insecure: it would let any app
        // read the secret).
        "-T", "/usr/bin/security",
      ].join(" ");
      // Refuse an over-long interactive line (the parser would split it and
      // falsely report success); fall back to in-file encryption instead.
      if (Buffer.byteLength(line, "utf-8") >= SECURITY_LINE_LIMIT) return false;
      const { code } = await run("security", ["-i"], { input: line + "\n" });
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
  // A malicious keychain: reference could carry a control character in the
  // account; refuse rather than risk interactive-parser command injection.
  if (!isSafeToken(account)) return undefined;
  // Only a prior READ timeout fast-fails a read — a write/detection timeout must
  // not disable reads, or a working key would be silently dropped this session.
  if (readBreaker) return undefined;
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
      const { code, stdout } = await run("security", ["-i"], { input: line, isRead: true });
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
      ], { isRead: true });
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
      const { code, stdout } = await runWindows(script, undefined, true);
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
  if (!isSafeToken(account)) return;
  if (writeBreaker) return;
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
function runWindows(script: string, secret?: string, isRead = false): Promise<{ code: number; stdout: string }> {
  return run(
    windowsPowerShellPath(),
    ["-NoProfile", "-NonInteractive", "-Command", script],
    {
      ...(secret === undefined ? {} : { env: { AGAV_KC_SECRET: secret } }),
      isRead,
    },
  );
}
