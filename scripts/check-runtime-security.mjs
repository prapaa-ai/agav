#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { monitorAdvisories, readReview } from "./runtime-monitor.mjs";

try {
  const args = process.argv.slice(2);
  if (args.some(arg => arg !== "--live")) throw new Error("Usage: node scripts/check-runtime-security.mjs [--live]");
  const root = process.cwd();
  const policy = readReview(root);
  const inventory = script => JSON.parse(execFileSync(process.execPath,
    [resolve(root, script), "--inventory-json"], { encoding: "utf8", timeout: 30000 }));
  // Both offline gates run first (fail-closed on a below-floor pin), then their
  // inventories are merged so the live monitor queries a feed for every recorded
  // source — the Bun runtime + its vendored C libs AND the native voice helper's
  // statically-linked components.
  const versions = { ...inventory("scripts/check-bun-advisories.mjs"), ...inventory("scripts/check-voice-advisories.mjs") };
  console.log(`Runtime policy reviewed ${policy.reviewedAt}; owner ${policy.owner}; expires after ${policy.maxAgeDays} days.`);
  if (args.includes("--live")) console.log(await monitorAdvisories(versions, policy));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
