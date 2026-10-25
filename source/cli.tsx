#!/usr/bin/env node

// Bun-compiled binaries don't trust the system certificate chain.
// Allow HTTPS connections to API providers when running as a compiled binary.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
if ("Bun" in globalThis) {
  process.env["NODE_TLS_REJECT_UNAUTHORIZED"] = "0";
}

import { BACKGROUND_TICK_INTERNAL_FLAG, SUPERVISOR_INTERNAL_FLAG, WORKFLOW_RUNNER_INTERNAL_FLAG } from "./background-jobs/packaging/manifest.js";

try {
  if (process.argv[2] === SUPERVISOR_INTERNAL_FLAG) {
    const { runSupervisor } = await import("./background-jobs/supervisor/entry.js");
    await runSupervisor(process.argv.slice(3));
  } else if (process.argv[2] === BACKGROUND_TICK_INTERNAL_FLAG) {
    // Headless: never imports main.js, so Ink is never loaded or rendered.
    // This file is copied verbatim to build/cli.js, so it must stay plain JS.
    const entry = await import("./cli/job-cli.js").catch((error) => {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`background tick entry is unavailable in this build (${reason})`);
    });
    if (typeof entry?.runJobCli !== "function") {
      throw new Error("background tick entry is unavailable in this build (runJobCli export missing)");
    }
    const code = await entry.runJobCli(["tick", ...process.argv.slice(3)]);
    if (typeof code === "number") process.exitCode = code;
  } else if (process.argv[2] === WORKFLOW_RUNNER_INTERNAL_FLAG) {
    // Headless workflow runner: never imports main.js, so Ink is never loaded or rendered.
    const { runWorkflowRunner } = await import("./workflows/runner.js");
    const code = await runWorkflowRunner(process.argv[3]);
    if (typeof code === "number") process.exitCode = code;
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
    : process.argv[2] === BACKGROUND_TICK_INTERNAL_FLAG
      ? "background tick failed"
      : process.argv[2] === WORKFLOW_RUNNER_INTERNAL_FLAG
        ? "workflow runner failed"
        : (await import("./main.js")).hasStartupFinished() ? "failed" : "startup failed";
  process.stderr.write(`\n  Agav — ${stage}: ${message}\n\n`);
  process.exitCode = 1;
}
