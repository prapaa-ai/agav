// Preparation writes a draft to stdout only; stable publication reads reviewed
// version-specific notes. Never infer stable release notes after a squash merge.
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
const stablePattern = /^v[0-9]+\.[0-9]+\.[0-9]+$/;
const releasePattern = /^v[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?$/;

function previousTag(version, prerelease, preparing) {
  const tags = git("tag", "--list", "v*", "--sort=-version:refname",
    ...(prerelease ? ["--sort=-creatordate"] : [])).split("\n");
  return tags.find((tag) => {
    if (!(prerelease ? releasePattern : stablePattern).test(tag) || tag === `v${version}`) return false;
    // Stable preparation may run on beta, whose history diverged after the
    // previous squash. Use the previous stable tree, not a beta/root fallback.
    if (preparing && !prerelease) {
      const parts = tag.slice(1).split(".").map(BigInt);
      const current = version.split(".").map(BigInt);
      for (let i = 0; i < 3; i++) {
        if (parts[i] !== current[i]) return parts[i] < current[i];
      }
      return false;
    }
    const result = spawnSync("git", ["merge-base", "--is-ancestor", tag, "HEAD"], { encoding: "utf8" });
    if (result.error) throw result.error;
    if (result.status !== 0 && result.status !== 1) throw new Error(result.stderr || "Cannot check tag ancestry");
    return result.status === 0;
  });
}

function reviewedNotes(version) {
  const path = `docs/releases/v${version}.md`;
  let text;
  try { text = readFileSync(path, "utf8"); }
  catch (error) { throw new Error(`Cannot read reviewed release notes: ${path} (${error.message})`); }
  const content = text.replace(/<!--[\s\S]*?-->/g, "").replace(/^\s*#{1,6}\s+.*$/gm, "").trim();
  if (!content || /<!--\s*DRAFT\b/i.test(text)) {
    throw new Error(`Missing, empty or unreviewed release notes: ${path}. Prepare and review notes before merging.`);
  }
  return text;
}

function generatedNotes(base) {
  const rows = git("log", ...(base ? [`${base}..HEAD`] : ["HEAD"]),
    "--no-merges", "--format=%s%x09%h").split("\n").filter(Boolean);
  const groups = { Features: [], Fixes: [], "Other changes": [] };
  for (const row of rows) {
    const [subject, hash] = row.split("\t");
    if (/^(?:chore|ci|release)(?:\(release\))?:.*(?:bump.*version|bump.*release|release v?\d|\d+\.\d+\.\d+)/i.test(subject)) continue;
    const group = /^feat(?:\(|:|!)/.test(subject) ? "Features" : /^fix(?:\(|:|!)/.test(subject) ? "Fixes" : "Other changes";
    groups[group].push(`- ${subject} (${hash})`);
  }
  return Object.entries(groups).filter(([, entries]) => entries.length)
    .map(([name, entries]) => `### ${name}\n\n${entries.join("\n")}`).join("\n\n") + "\n";
}

try {
  const [mode, version] = process.argv.slice(2);
  if (!version || !/^[0-9]+\.[0-9]+\.[0-9]+(?:-[a-z]+(?:\.[0-9]+)?)?$/.test(version)) {
    throw new Error(`Invalid version: ${version ?? "(missing)"}`);
  }
  if (!["prepare", "validate", "publish"].includes(mode)) {
    throw new Error("Usage: node scripts/release-notes.mjs <prepare|validate|publish> <version>");
  }
  const prerelease = version.includes("-");
  if (mode === "validate") {
    if (!prerelease) reviewedNotes(version);
  } else if (mode === "publish" && !prerelease) {
    process.stdout.write(reviewedNotes(version));
  } else {
    const base = previousTag(version, prerelease, mode === "prepare");
    if (mode === "prepare" && !prerelease && !base) {
      throw new Error("No previous stable tag found. Fetch tags or write reviewed notes manually for the first stable release.");
    }
    console.error(`Release notes baseline: ${base ?? "all history (no ancestor release tag)"}`);
    if (mode === "prepare") {
      process.stdout.write(`<!-- DRAFT: review against git diff ${base ?? "<root>"} HEAD; remove already-shipped changes, duplicates and release noise, then remove this marker. -->\n\n`);
    }
    process.stdout.write(generatedNotes(base));
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
