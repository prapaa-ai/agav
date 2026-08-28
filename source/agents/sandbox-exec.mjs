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
 *   stdout → JSON: { output: string, isError: boolean } | { error: string }
 *
 * The tool module is loaded via dynamic import() — but because this process
 * runs inside the OS sandbox, the tool code cannot:
 *   - access ~/.ssh, ~/.aws, ~/.gnupg
 *   - write outside CWD or /tmp
 *   - make network connections
 *   - read credentials from the parent process's memory
 */

async function main() {
  let raw = "";
  for await (const chunk of process.stdin) {
    raw += chunk;
  }

  let request;
  try {
    request = JSON.parse(raw);
  } catch {
    process.stdout.write(JSON.stringify({ error: "Invalid JSON on stdin" }));
    process.exit(1);
  }

  const { toolPath, input } = request;
  if (!toolPath || typeof toolPath !== "string") {
    process.stdout.write(JSON.stringify({ error: "Missing toolPath" }));
    process.exit(1);
  }

  try {
    // Convert to file:// URL for cross-platform ESM import compatibility
    const { pathToFileURL } = await import("node:url");
    const mod = await import(pathToFileURL(toolPath).href);
    const toolDef = mod.default || mod;

    if (!toolDef.execute || typeof toolDef.execute !== "function") {
      process.stdout.write(
        JSON.stringify({ output: `Tool at ${toolPath} has no execute function`, isError: true }),
      );
      process.exit(0);
    }

    const result = await toolDef.execute(input || {});

    // Normalize the result to ensure it's serialisable
    const output = typeof result === "string"
      ? { output: result, isError: false }
      : {
          output: String(result?.output ?? ""),
          isError: Boolean(result?.isError),
        };

    process.stdout.write(JSON.stringify(output));
  } catch (err) {
    process.stdout.write(
      JSON.stringify({
        output: `Sandboxed tool execution failed: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      }),
    );
  }
}

main().catch((err) => {
  process.stdout.write(JSON.stringify({ error: String(err) }));
  process.exit(1);
});
