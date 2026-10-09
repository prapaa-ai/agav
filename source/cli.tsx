#!/usr/bin/env node

// Bun-compiled binaries don't trust the system certificate chain.
// Allow HTTPS connections to API providers when running as a compiled binary.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
if ("Bun" in globalThis) {
  process.env["NODE_TLS_REJECT_UNAUTHORIZED"] = "0";
}

import { SUPERVISOR_INTERNAL_FLAG } from "./background-jobs/packaging/manifest.js";

try {
  if (process.argv[2] === SUPERVISOR_INTERNAL_FLAG) {
    const { runSupervisor } = await import("./background-jobs/supervisor/entry.js");
    await runSupervisor(process.argv.slice(3));
  } else {
    const { main } = await import("./main.js");
    await main();
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  // Anything thrown after startup is a session failure; calling it a startup
  // failure sent people off auditing their config for unrelated crashes.
  const stage = process.argv[2] === SUPERVISOR_INTERNAL_FLAG
    ? "supervisor failed"
    : (await import("./main.js")).hasStartupFinished() ? "failed" : "startup failed";
  process.stderr.write(`\n  Agav — ${stage}: ${message}\n\n`);
  process.exitCode = 1;
}
