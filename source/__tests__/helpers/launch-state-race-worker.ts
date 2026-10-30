// Real-process fixture: only the home and a gate after the state read are
// substituted. State writes and cross-process locks use the real filesystem.
import os from "node:os";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";

const home = process.env["LAUNCH_STATE_TEST_HOME"];
if (!home) throw new Error("LAUNCH_STATE_TEST_HOME is required");
os.homedir = () => home;
const statePath = join(home, ".agav", "launch-state.json");
const originalRead = fs.readFile;
let hold = process.env["LAUNCH_STATE_TEST_HOLD"] === "1";
const released = new Promise<void>((resolve) => {
  process.on("message", (message) => { if (message === "release") resolve(); });
});
fs.readFile = (async (...args: Parameters<typeof fs.readFile>) => {
  if (String(args[0]) !== statePath) return originalRead(...args);
  process.send?.({ type: "read" });
  try {
    return await originalRead(...args);
  } finally {
    // Hold the snapshot after the actual read, before the caller can use it.
    if (hold) {
      hold = false;
      process.send?.({ type: "held" });
      await released;
    }
  }
}) as typeof fs.readFile;
syncBuiltinESMExports();

const { consumeChangelogDisplay, setChangelogAutoDisplay } = await import("../../config/launch-state.js");
const go = new Promise<void>((resolve) => {
  process.on("message", (message) => { if (message === "go") resolve(); });
});
process.send?.({ type: "ready" });
await go;
process.send?.({ type: "started" });
try {
  const operation = process.env["LAUNCH_STATE_TEST_OPERATION"];
  let value: boolean;
  if (operation === "startup") value = await consumeChangelogDisplay("0.3.1");
  else if (operation === "off") value = await setChangelogAutoDisplay(false);
  else throw new Error(`Unknown launch-state operation: ${operation}`);
  process.send?.({ type: "done", value });
} catch (error) {
  process.send?.({ type: "error", value: String(error) });
}
process.disconnect?.();
