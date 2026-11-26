import { mock } from "node:test";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { runWorkflowsCli } from "../../cli/workflows-cli.ts";
import { FakeCoordinator } from "./workflow-fixtures.ts";

// Keep the real consent, launch serialization, and main exit path; avoid starting real jobs.
const stdin = Object.assign(new PassThrough(), { isTTY: true });
stdin.end(process.env.WORKFLOW_TEST_APPROVAL ?? "y\n");
const stderr = Object.assign(process.stderr, { isTTY: true });
mock.module(new URL("../../cli/workflows-cli.ts", import.meta.url).href, {
  namedExports: {
    runWorkflowsCli: (argv, options) => runWorkflowsCli(argv, {
      ...options,
      stdin,
      stderr,
      env: {},
      getCoordinator: async () => new FakeCoordinator(),
      cliPath: fileURLToPath(new URL("../../cli.tsx", import.meta.url)),
    }),
  },
});

const { main } = await import("../../main.tsx");
await main();
