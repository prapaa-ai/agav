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

// Keep attribution separate from change text: stable squash promotions lose the
// original commit range, so their contributor list must be reviewed beforehand.
function reviewedContributors(version) {
  const path = `docs/releases/v${version}.contributors.json`;
  let people;
  try { people = JSON.parse(readFileSync(path, "utf8")); }
  catch (error) { throw new Error(`Cannot read reviewed contributors: ${path} (${error.message})`); }
  if (!Array.isArray(people) || people.some(person => typeof person !== "string" || !person.trim() || /[\r\n]/.test(person))) {
    throw new Error(`Invalid reviewed contributors: ${path}. Expected an array of names or @GitHub usernames.`);
  }
  return people.map(person => ({ name: person.trim(), login: /^@[a-z\d](?:[a-z\d-]*[a-z\d])?$/i.test(person.trim()) }));
}

function generatedContributors(base) {
  // Extract only final trailers, not full squash bodies (which can contain
  // megabytes of nested, already-shipped commits and co-author text).
  const records = git("log", ...(base ? [`${base}..HEAD`] : ["HEAD"]),
    "--format=%aN%x00%aE%x00%(trailers:key=Co-authored-by,valueonly,separator=%x00)%x1e").split("\x1e");
  const people = new Map();
  const add = (name, email) => {
    name = name.trim();
    email = email.trim().toLowerCase();
    if (["noreply@anthropic.com", "noreply@openai.com"].includes(email)) return;
    if (!name || /\[bot\]/i.test(name + email) || /^(?:dependabot|renovate|github-actions)(?:@|$)/i.test(email)) return;
    const login = /^(?:\d+\+)?([a-z\d](?:[a-z\d-]*[a-z\d])?)@users\.noreply\.github\.com$/i.exec(email)?.[1];
    // git log is newest first; retain the current name for an email identity.
    if (!people.has(email)) people.set(email, { name: login ? `@${login}` : name, login: Boolean(login) });
  };
  for (const record of records) {
    const [name, email, ...trailers] = record.trim().split("\x00");
    if (!email) continue;
    add(name, email);
    for (const trailer of trailers) {
      const match = /^\s*(.*?)\s*<([^<>]+)>\s*$/.exec(trailer);
      if (match) add(match[1], match[2]);
    }
  }
  return [...people.values()];
}


function contributorSection(people) {
  if (!people.length) return "";
  const handles = new Set();
  const entries = [...people].sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase(), "en"))
    .filter(person => {
      if (!person.login) return true;
      const key = person.name.toLowerCase();
      if (handles.has(key)) return false;
      handles.add(key);
      return true;
    }).map(person => {
    // Only verified noreply identities or explicitly reviewed handles become
    // mentions. Escape plain names so commit metadata cannot inject Markdown.
    const label = person.login
      ? person.name : person.name.replace(/[\\`*_{}\[\]()<>#!|@]/g, "\\$&");
    return `- ${label}`;
  });
  return `## Contributors\n\nThank you to everyone who contributed to this release!\n\n${entries.join("\n")}\n`;
}

try {
  const [mode, version] = process.argv.slice(2);
  if (!version || !/^[0-9]+\.[0-9]+\.[0-9]+(?:-[a-z]+(?:\.[0-9]+)?)?$/.test(version)) {
    throw new Error(`Invalid version: ${version ?? "(missing)"}`);
  }
  if (!["prepare", "validate", "publish", "prepare-contributors", "contributors"].includes(mode)) {
    throw new Error("Usage: node scripts/release-notes.mjs <prepare|validate|publish|prepare-contributors|contributors> <version>");
  }
  const prerelease = version.includes("-");
  if (mode === "validate") {
    if (!prerelease) {
      reviewedNotes(version);
      reviewedContributors(version);
    }
  } else if (mode === "contributors" && !prerelease) {
    process.stdout.write(contributorSection(reviewedContributors(version)));
  } else if (mode === "publish" && !prerelease) {
    process.stdout.write(reviewedNotes(version));
  } else {
    const preparing = mode === "prepare" || mode === "prepare-contributors";
    const base = previousTag(version, prerelease, preparing);
    if (preparing && !prerelease && !base) {
      throw new Error("No previous stable tag found. Fetch tags or write reviewed notes manually for the first stable release.");
    }
    console.error(`Release notes baseline: ${base ?? "all history (no ancestor release tag)"}`);
    if (mode === "prepare-contributors") {
      process.stdout.write(JSON.stringify(generatedContributors(base).map(person => person.name).sort((a, b) => a.localeCompare(b, "en")), null, 2) + "\n");
    } else if (mode === "contributors") {
      process.stdout.write(contributorSection(generatedContributors(base)));
    } else {
      if (mode === "prepare") {
        process.stdout.write(`<!-- DRAFT: review against git diff ${base ?? "<root>"} HEAD; remove already-shipped changes, duplicates and release noise, then remove this marker. -->\n\n`);
      }
      process.stdout.write(generatedNotes(base));
    }
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
