// Real-process fixture. Only the home and transaction gates are substituted;
// all account/device writes and exclusive locks use the real FS.
import os from "node:os";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";

os.homedir = () => process.env["ACCOUNT_TEST_HOME"]!;
const originalRead = fs.readFile;
const originalWrite = fs.writeFile;
const originalRemove = fs.rm;
let hold = process.env["ACCOUNT_TEST_HOLD"] === "1";
const released = new Promise<void>((resolve) => {
  process.on("message", (message) => { if (message === "release") resolve(); });
});
async function transactionGate() {
  // Preserve the existing fixture protocol: "read" now marks the first account
  // transaction I/O, since save/logout no longer read the previous metadata.
  process.send?.({ type: "read" });
  if (hold) {
    hold = false;
    process.send?.({ type: "held" });
    await released;
  }
}
fs.readFile = (async (...args: Parameters<typeof fs.readFile>) => {
  if (!/[\\/](account|device)\.json$/.test(String(args[0]))) return originalRead(...args);
  try {
    return await originalRead(...args);
  } finally {
    await transactionGate();
  }
}) as typeof fs.readFile;
fs.writeFile = (async (...args: Parameters<typeof fs.writeFile>) => {
  if (/[\\/]account\.json\.[0-9a-f]+\.tmp$/.test(String(args[0]))) await transactionGate();
  return originalWrite(...args);
}) as typeof fs.writeFile;
fs.rm = (async (...args: Parameters<typeof fs.rm>) => {
  if (/[\\/]account\.json$/.test(String(args[0]))) await transactionGate();
  return originalRemove(...args);
}) as typeof fs.rm;
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
