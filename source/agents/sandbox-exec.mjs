#!/usr/bin/env node
/**
 * Sandboxed agent tool executor.
 *
 * This script is spawned as a subprocess inside an OS-level sandbox
 * (Seatbelt / Bubblewrap) to execute marketplace agent tool code in
 * isolation from the main Agav process.
 *
 * Protocol (over stdin/stdout):
 *   stdin  ← JSON: { toolPath: string, input: Record<string, unknown> }
 *   stdout → delimited JSON: __AGAV_RESULT__\n{ output: string, isError: boolean } | { error: string }
 *
 * The tool module is loaded via dynamic import() — but because this process
 * runs inside the OS sandbox, the tool code cannot:
 *   - access ~/.ssh, ~/.aws, ~/.gnupg, ~/.agav
 *   - write outside CWD or /tmp
 *   - make network connections
 *   - read credentials from the parent process's memory
 */

const RESULT_DELIMITER = "__AGAV_RESULT__";

function writeResult(data) {
  process.stdout.write(`\n${RESULT_DELIMITER}\n${JSON.stringify(data)}\n`);
}

async function main() {
  let raw = "";
  for await (const chunk of process.stdin) {
    raw += chunk;
  }

  let request;
  try {
    request = JSON.parse(raw);
  } catch {
    writeResult({ error: "Invalid JSON on stdin" });
    process.exitCode = 1;
    return;
  }

  const { toolPath, input } = request;
  if (!toolPath || typeof toolPath !== "string") {
    writeResult({ error: "Missing toolPath" });
    process.exitCode = 1;
    return;
  }

  try {
    // Convert to file:// URL for cross-platform ESM import compatibility
    const { pathToFileURL } = await import("node:url");
    const mod = await import(pathToFileURL(toolPath).href);
    const toolDef = mod.default || mod;

    if (!toolDef.execute || typeof toolDef.execute !== "function") {
      writeResult({ output: `Tool at ${toolPath} has no execute function`, isError: true });
      return;
    }

    const result = await toolDef.execute(input || {});

    // Normalize the result to ensure it's serialisable
    const output = typeof result === "string"
      ? { output: result, isError: false }
      : {
          output: String(result?.output ?? ""),
          isError: Boolean(result?.isError),
        };

    writeResult(output);
  } catch (err) {
    writeResult({
      output: `Sandboxed tool execution failed: ${err instanceof Error ? err.message : String(err)}`,
      isError: true,
    });
  }
}

main().catch((err) => {
  writeResult({ error: String(err) });
  process.exitCode = 1;
});

