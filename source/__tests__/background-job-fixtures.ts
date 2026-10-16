import { execFile } from "node:child_process";
import { promisify } from "node:util";

// A bounded Node fixture uses neither POSIX sleep nor Windows timeout.exe.
export function fixtureCommand(text: string, delayMs = 0): string {
  const code = `setTimeout(() => console.log('${text}'), ${delayMs})`;
  return `"${process.execPath}" -e "${code}"`;
}

export async function killWindowsFixtureSupervisor(jobId: string): Promise<void> {
  if (!/^[a-f0-9-]{36}$/.test(jobId)) throw new Error("Expected fixture UUID");
  const { stdout } = await promisify(execFile)("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    `Get-CimInstance Win32_Process -Filter \"name = 'node.exe'\" | Where-Object { $_.CommandLine -like '*supervisor*entry.js* ${jobId} *' } | ForEach-Object { $_.ProcessId }`,
  ]);
  // Fresh command-line corroboration tied to this fixture's UUID, not a stale
  // production job-record PID. No tree walk or arbitrary user state is used.
  for (const value of stdout.trim().split(/\s+/)) {
    if (/^\d+$/.test(value)) {
      try { process.kill(Number(value)); } catch { /* Already exited. */ }
    }
  }
}
