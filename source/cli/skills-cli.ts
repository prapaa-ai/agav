/**
 * CLI handlers for skill management commands (`agav skills <command>`)
 */

import { loadAllSkills } from "../skills/loader.js";
import { installFromUrl, installFromPath, removeSkill, clearSkills } from "../skills/marketplace.js";
import { setSkillEnabled } from "../skills/skill-registry.js";
import { slugify } from "../skills/skill-utils.js";

/**
 * List all skills grouped by origin, marking disabled ones.
 */
async function listSkills(): Promise<number> {
  const skills = await loadAllSkills();

  if (skills.length === 0) {
    console.log("\nNo skills installed.\n");
    return 0;
  }

  console.log("\nInstalled skills:\n");

  const groups: Array<[string, typeof skills]> = [
    ["Bundled", skills.filter((s) => s.origin === "bundled")],
    ["Global", skills.filter((s) => s.origin === "global")],
    ["Project", skills.filter((s) => s.origin === "project")],
  ];

  for (const [label, group] of groups) {
    if (group.length === 0) continue;
    console.log(`${label}:`);
    for (const s of group) {
      const status = s.disabled ? "[disabled]" : "[enabled]";
      console.log(`  • ${s.slug} ${status}`);
      console.log(`    ${s.description}`);
    }
    console.log();
  }

  return 0;
}

/**
 * Install a skill from a URL or local path.
 */
async function installSkillCommand(args: string[]): Promise<number> {
  if (args.length === 0) {
    console.error("\nError: No source URL or path provided.\n");
    console.error("Usage: agav skills add <url|path>\n");
    return 1;
  }

  const source = args[0]!;
  console.log(`\nInstalling skill from ${source}...\n`);

  const result = source.startsWith("http")
    ? await installFromUrl(source)
    : await installFromPath(source);

  if ("error" in result) {
    console.error(`Error: ${result.error}\n`);
    return 1;
  }

  if ("names" in result) {
    console.log(`✓ Installed ${result.names.length} skills: ${result.names.join(", ")}`);
    if (result.failed.length > 0) {
      console.error(`  ⚠ Failed (${result.failed.length}): ${result.failed.join(", ")}`);
    }
  } else {
    console.log(`✓ Installed skill: ${result.name}`);
  }
  for (const w of result.warnings) console.error(`  ⚠ ${w}`);
  console.log("  Restart Agav to activate.\n");
  return 0;
}

/**
 * Remove an installed global skill.
 */
async function removeSkillCommand(args: string[]): Promise<number> {
  if (args.length === 0) {
    console.error("\nError: No skill name provided.\n");
    console.error("Usage: agav skills remove <name>\n");
    return 1;
  }

  const name = args[0]!;
  // Bundled skills can't be removed (they live in the binary); project skills
  // belong to the repo. Direct the user to `disable` rather than reporting a
  // false success or a bare "not found".
  const slug = slugify(name);
  const skill = (await loadAllSkills()).find((s) => s.slug === slug || s.name === name);
  if (skill && skill.origin === "bundled") {
    console.error(`\nError: "${skill.name}" is a bundled skill and can't be removed.`);
    console.error(`Use 'agav skills disable ${skill.slug}' to turn it off instead.\n`);
    return 1;
  }
  if (skill && skill.origin === "project") {
    console.error(`\nError: "${skill.name}" is a project skill.`);
    console.error(`Delete it from .agav/skills/ in the repo, or use 'agav skills disable ${skill.slug}'.\n`);
    return 1;
  }

  const removed = await removeSkill(name);
  if (!removed) {
    console.error(`\nError: Skill "${name}" not found (only global skills can be removed).\n`);
    return 1;
  }
  console.log(`\n✓ Removed skill: ${name}. Restart Agav to apply.\n`);
  return 0;
}

/**
 * Remove all user-installed (global) skills.
 */
async function clearSkillsCommand(): Promise<number> {
  const removed = await clearSkills();
  if (removed.length === 0) {
    console.log("\nNo user-installed skills to remove.\n");
    return 0;
  }
  console.log(`\n✓ Removed ${removed.length} skill${removed.length === 1 ? "" : "s"}: ${removed.join(", ")}.`);
  console.log("  Bundled skills are unaffected. Restart Agav to apply.\n");
  return 0;
}

/**
 * Enable or disable a skill by name. Works on bundled skills, which cannot be
 * removed because they are compiled into the binary.
 */
async function setEnabledCommand(args: string[], enabled: boolean): Promise<number> {
  const verb = enabled ? "enable" : "disable";
  if (args.length === 0) {
    console.error(`\nError: No skill name provided.\n`);
    console.error(`Usage: agav skills ${verb} <name>\n`);
    return 1;
  }

  const name = args[0]!;
  const slug = slugify(name);
  const skill = (await loadAllSkills()).find((s) => s.slug === slug || s.name === name);
  if (!skill) {
    console.error(`\nError: Skill "${name}" not found.\n`);
    return 1;
  }

  try {
    await setSkillEnabled(skill.slug, enabled);
    console.log(`\n✓ ${enabled ? "Enabled" : "Disabled"} skill: ${skill.name}. Restart Agav to apply.\n`);
    return 0;
  } catch (error) {
    console.error(`\nError: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

/**
 * Main entry point for skill CLI commands.
 */
export async function runSkillsCommand(command: string | undefined, args: string[]): Promise<number> {
  if (!command || command === "list") {
    return await listSkills();
  }

  switch (command) {
    case "add":
    case "install":
      return await installSkillCommand(args);
    case "remove":
    case "rm":
    case "uninstall":
      return await removeSkillCommand(args);
    case "clear":
      return await clearSkillsCommand();
    case "enable":
      return await setEnabledCommand(args, true);
    case "disable":
      return await setEnabledCommand(args, false);
    default:
      console.error(`\nError: Unknown command '${command}'\n`);
      console.error("Available commands: list, add, remove, clear, enable, disable\n");
      return 1;
  }
}
