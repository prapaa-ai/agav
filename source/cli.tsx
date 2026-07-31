#!/usr/bin/env node

// Bun-compiled binaries don't trust the system certificate chain.
// Allow HTTPS connections to API providers when running as a compiled binary.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
if ("Bun" in globalThis) {
  process.env["NODE_TLS_REJECT_UNAUTHORIZED"] = "0";
}

import { main } from "./main.js";

await main();
