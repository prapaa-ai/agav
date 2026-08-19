#!/usr/bin/env node

// Bun-compiled binaries don't trust the system certificate chain.
// Allow HTTPS connections to API providers when running as a compiled binary.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
if ("Bun" in globalThis) {
  process.env["NODE_TLS_REJECT_UNAUTHORIZED"] = "0";
}

import { hasStartupFinished, main } from "./main.js";

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  // Anything thrown after startup is a session failure; calling it a startup
  // failure sent people off auditing their config for unrelated crashes.
  const stage = hasStartupFinished() ? "failed" : "startup failed";
  process.stderr.write(`\n  Agav — ${stage}: ${message}\n\n`);
  process.exitCode = 1;
}
