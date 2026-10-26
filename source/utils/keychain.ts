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
 */

import { execFile } from "node:child_process";
import { platform } from "node:os";

/** Fixed service/namespace for every Agav credential-store entry. */
const SERVICE = "agav-cli";

/**
 * Placeholder written into config.json in place of a secret when the value
 * lives in the OS credential store. `loadConfig` resolves it back to the real
 * secret via `getSecret`. Distinct from the "enc:" prefix used by the file
 * fallback so the two storage modes never collide.
 */
const KEYCHAIN_PREFIX = "keychain:";

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

/** Run a command with no shell, resolving { code, stdout } and never rejecting. */
function run(
  file: string,
  args: string[],
  input?: string,
): Promise<{ code: number; stdout: string }> {
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
        { timeout: 5000, maxBuffer: 1024 * 1024, windowsHide: true },
        (error, stdout) => {
          if (error) {
            // execFile reports a non-zero exit via error.code (a number) or a
            // spawn failure (ENOENT → tool missing) via a string code.
            const code = typeof (error as NodeJS.ErrnoException & { code?: number }).code === "number"
              ? ((error as unknown as { code: number }).code)
              : 1;
            done(code, stdout ?? "");
            return;
          }
          done(0, stdout ?? "");
        },
      );
      child.on("error", () => done(1, ""));
      if (input !== undefined) {
        child.stdin?.end(input);
      }
    } catch {
      done(1, "");
    }
  });
}

type Backend = "macos" | "secret-tool" | "windows" | "none";

let cachedBackend: Backend | undefined;

/** Detect the usable credential-store backend for this platform, once. */
async function detectBackend(): Promise<Backend> {
  if (cachedBackend !== undefined) return cachedBackend;
  const os = platform();
  if (os === "darwin") {
    // `security` ships with macOS; a help invocation confirms it is callable.
    const { code } = await run("security", ["help"]);
    cachedBackend = code === 0 ? "macos" : "none";
  } else if (os === "linux") {
    // secret-tool is the libsecret CLI; absent on headless/minimal installs.
    const { code } = await run("secret-tool", ["--version"]);
    cachedBackend = code === 0 ? "secret-tool" : "none";
  } else if (os === "win32") {
    const { code } = await run("powershell", ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.Major"]);
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

/**
 * Store `secret` under `account` in the OS credential store. Returns true on
 * success. Overwrites any existing entry for the same account so re-saving a
 * rotated key does not accumulate duplicates. Never throws.
 */
export async function setSecret(account: string, secret: string): Promise<boolean> {
  if (!account || !secret) return false;
  const backend = await detectBackend();
  switch (backend) {
    case "macos": {
      // -U updates an existing item; -w takes the secret as an argument. The
      // secret is passed as an argv element (no shell), so it is not exposed to
      // any shell parsing, but it is visible in the process list for the brief
      // lifetime of the call — acceptable and the standard `security` usage.
      const { code } = await run("security", [
        "add-generic-password",
        "-U",
        "-s", SERVICE,
        "-a", account,
        "-w", secret,
      ]);
      return code === 0;
    }
    case "secret-tool": {
      // secret-tool reads the secret from stdin, so it never appears in argv or
      // the process list. Attributes identify the entry for later lookup.
      const { code } = await run(
        "secret-tool",
        ["store", "--label", `${SERVICE}: ${account}`, "service", SERVICE, "account", account],
        secret,
      );
      return code === 0;
    }
    case "windows": {
      // Store the DPAPI-protected secret in the Credential Manager. The secret
      // is passed via an environment variable to the child so it never appears
      // on the command line or in the process list.
      const target = `${SERVICE}:${account}`;
      const script =
        "$ErrorActionPreference='Stop';" +
        "Add-Type -AssemblyName System.Security;" +
        "$b=[Text.Encoding]::UTF8.GetBytes($env:AGAV_KC_SECRET);" +
        "$p=[Security.Cryptography.ProtectedData]::Protect($b,$null,'CurrentUser');" +
        "$enc=[Convert]::ToBase64String($p);" +
        `cmdkey /generic:${psQuote(target)} /user:${psQuote(SERVICE)} /pass:$enc | Out-Null`;
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
  const backend = await detectBackend();
  switch (backend) {
    case "macos": {
      const { code, stdout } = await run("security", [
        "find-generic-password",
        "-s", SERVICE,
        "-a", account,
        "-w",
      ]);
      if (code !== 0) return undefined;
      const value = stdout.replace(/\r?\n$/, "");
      return value.length ? value : undefined;
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
        `$o=cmdkey /list:${psQuote(target)};` +
        // cmdkey never prints the password; read it back via the stored blob.
        // We store the base64 DPAPI blob as the password, which cmdkey will not
        // reveal, so instead we keep the blob in a companion registry-free step:
        // re-derive by reading from Credential Manager via the Win32 API.
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
  const backend = await detectBackend();
  switch (backend) {
    case "macos":
      await run("security", ["delete-generic-password", "-s", SERVICE, "-a", account]);
      return;
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
  return new Promise((resolve) => {
    let settled = false;
    const done = (code: number, stdout: string) => {
      if (settled) return;
      settled = true;
      resolve({ code, stdout });
    };
    try {
      const child = execFile(
        "powershell",
        ["-NoProfile", "-NonInteractive", "-Command", script],
        {
          timeout: 5000,
          maxBuffer: 1024 * 1024,
          windowsHide: true,
          env: secret === undefined ? process.env : { ...process.env, AGAV_KC_SECRET: secret },
        },
        (error, stdout) => {
          if (error) {
            const code = typeof (error as unknown as { code?: number }).code === "number"
              ? (error as unknown as { code: number }).code
              : 1;
            done(code, stdout ?? "");
            return;
          }
          done(0, stdout ?? "");
        },
      );
      child.on("error", () => done(1, ""));
    } catch {
      done(1, "");
    }
  });
}
