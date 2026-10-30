// Real-process fixture. Only the home, credential backend and a read gate are
// substituted; all account/device writes and exclusive locks use the real FS.
import os from "node:os";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";

os.homedir = () => process.env["ACCOUNT_TEST_HOME"]!;
// Never access the developer's real credential store in a child process.
os.platform = () => "test" as NodeJS.Platform;
const originalRead = fs.readFile;
let hold = process.env["ACCOUNT_TEST_HOLD"] === "1";
const released = new Promise<void>((resolve) => {
  process.on("message", (message) => { if (message === "release") resolve(); });
});
fs.readFile = (async (...args: Parameters<typeof fs.readFile>) => {
  if (!/[\\/](account|device)\.json$/.test(String(args[0]))) return originalRead(...args);
  process.send?.({ type: "read" });
  try {
    return await originalRead(...args);
  } finally {
    if (hold) {
      hold = false;
      process.send?.({ type: "held" });
      await released;
    }
  }
}) as typeof fs.readFile;
syncBuiltinESMExports();

const { saveStoredAccount, clearStoredAccount, loadStoredAccount } = await import("../../account/account-store.js");
const { getOrCreateDeviceId } = await import("../../account/device-id.js");
process.send?.({ type: "ready" });
await new Promise<void>((resolve) => {
  process.on("message", (message) => { if (message === "go") resolve(); });
});
process.send?.({ type: "started" });
try {
  const operation = process.env["ACCOUNT_TEST_OPERATION"]!;
  let value: unknown;
  if (operation === "device") value = await getOrCreateDeviceId();
  else if (operation === "logout") await clearStoredAccount();
  else if (operation === "load") value = await loadStoredAccount();
  else await saveStoredAccount({
    accountId: operation, apiKey: `secret-${operation}`, email: "a@b.com",
    status: "active", accountService: "https://agav.dev", storedAt: "2026-01-01T00:00:00.000Z",
  });
  process.send?.({ type: "done", value });
} catch (error) {
  process.send?.({ type: "error", value: String(error) });
}
process.disconnect?.();
