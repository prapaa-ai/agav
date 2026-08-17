/**
 * CLI handlers for agent management commands
 */

import { loadAgents } from "../agents/loader.js";
import { installAgent, uninstallAgent } from "../agents/installer.js";
import { setAgentEnabled, loadRegistry } from "../agents/agent-registry.js";

/**
 * List installed agents
 */
async function listAgents(): Promise<number> {
  const agents = await loadAgents();

  if (agents.length === 0) {
    console.log("\nNo agents installed.\n");
    return 0;
  }

  console.log("\nInstalled agents:\n");

  // Group by origin
  const bundled = agents.filter((a) => a.origin === "bundled");
  const global = agents.filter((a) => a.origin === "global");
  const project = agents.filter((a) => a.origin === "project");

  if (bundled.length > 0) {
    console.log("Bundled:");
    for (const agent of bundled) {
      const status = agent.manifest.enabled === false ? "[disabled]" : "[enabled]";
      const name = agent.alias || agent.manifest.name;
      console.log(`  • ${name} ${status}`);
      console.log(`    ${agent.manifest.description}`);
      console.log(`    Tools: ${agent.tools.length}`);
    }
    console.log();
  }

  if (global.length > 0) {
    console.log("Global:");
    for (const agent of global) {
      const status = agent.manifest.enabled === false ? "[disabled]" : "[enabled]";
      const name = agent.alias || agent.manifest.name;
      console.log(`  • ${name} ${status}`);
      console.log(`    ${agent.manifest.description}`);
      console.log(`    Tools: ${agent.tools.length}`);
    }
    console.log();
  }

  if (project.length > 0) {
    console.log("Project:");
    for (const agent of project) {
      const status = agent.manifest.enabled === false ? "[disabled]" : "[enabled]";
      const name = agent.alias || agent.manifest.name;
      console.log(`  • ${name} ${status}`);
      console.log(`    ${agent.manifest.description}`);
      console.log(`    Tools: ${agent.tools.length}`);
    }
    console.log();
  }

  return 0;
}

/**
 * Install agent from URL or local path
 */
async function installAgentCommand(args: string[]): Promise<number> {
  if (args.length === 0) {
    console.error("\nError: No source URL or path provided.\n");
    console.error("Usage: agav agents install <url|path> [--alias name] [--destination global|project]\n");
    return 1;
  }

  const source = args[0]!;
  let alias: string | undefined;
  let destination: "global" | "project" = "global";

  // Parse flags
  for (let i = 1; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--alias" && args[i + 1]) {
      alias = args[++i]!;
    } else if (arg === "--destination" && args[i + 1]) {
      const dest = args[++i]!;
      if (dest !== "global" && dest !== "project") {
        console.error("\nError: --destination must be 'global' or 'project'\n");
        return 1;
      }
      destination = dest;
    }
  }

  console.log(`\nInstalling agent from ${source}...\n`);

  const result = await installAgent(source, { alias, destination });

  if (!result.success) {
    console.error(`Error: ${result.error}\n`);
    return 1;
  }

  const agentName = alias || result.agent?.manifest.name || "agent";
  console.log(`✓ Successfully installed agent: ${agentName}`);
  console.log(`  Description: ${result.agent?.manifest.description}`);
  console.log(`  Tools: ${result.agent?.tools.length}`);
  console.log(`  Origin: ${destination}\n`);

  return 0;
}

/**
 * Uninstall agent
 */
async function removeAgentCommand(args: string[]): Promise<number> {
  if (args.length === 0) {
    console.error("\nError: No agent name provided.\n");
    console.error("Usage: agav agents remove <name> [--destination global|project]\n");
    return 1;
  }

  const name = args[0]!;
  let destination: "global" | "project" = "global";

  // Parse flags
  for (let i = 1; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--destination" && args[i + 1]) {
      const dest = args[++i]!;
      if (dest !== "global" && dest !== "project") {
        console.error("\nError: --destination must be 'global' or 'project'\n");
        return 1;
      }
      destination = dest;
    }
  }

  console.log(`\nRemoving agent: ${name}...\n`);

  const result = await uninstallAgent(name, destination);

  if (!result.success) {
    console.error(`Error: ${result.error}\n`);
    return 1;
  }

  console.log(`✓ Successfully removed agent: ${name}\n`);
  return 0;
}

/**
 * Enable agent
 */
async function enableAgentCommand(args: string[]): Promise<number> {
  if (args.length === 0) {
    console.error("\nError: No agent name provided.\n");
    console.error("Usage: agav agents enable <name>\n");
    return 1;
  }

  const name = args[0]!;

  console.log(`\nEnabling agent: ${name}...\n`);

  try {
    await setAgentEnabled(name, true);
    console.log(`✓ Agent '${name}' enabled\n`);
    return 0;
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

/**
 * Disable agent
 */
async function disableAgentCommand(args: string[]): Promise<number> {
  if (args.length === 0) {
    console.error("\nError: No agent name provided.\n");
    console.error("Usage: agav agents disable <name>\n");
    return 1;
  }

  const name = args[0]!;

  console.log(`\nDisabling agent: ${name}...\n`);

  try {
    await setAgentEnabled(name, false);
    console.log(`✓ Agent '${name}' disabled\n`);
    return 0;
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

/**
 * Main entry point for agent CLI commands
 */
export async function runAgentsCommand(command: string | undefined, args: string[]): Promise<number> {
  if (!command || command === "list") {
    return await listAgents();
  }

  switch (command) {
    case "install":
      return await installAgentCommand(args);
    case "remove":
    case "uninstall":
      return await removeAgentCommand(args);
    case "enable":
      return await enableAgentCommand(args);
    case "disable":
      return await disableAgentCommand(args);
    default:
      console.error(`\nError: Unknown command '${command}'\n`);
      console.error("Available commands: list, install, remove, enable, disable\n");
      return 1;
  }
}
