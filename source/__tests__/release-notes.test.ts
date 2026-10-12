import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parse } from "yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");
const script = join(root, "scripts/release-notes.mjs");
const workflow = parse(readFileSync(join(root, ".github/workflows/release.yml"), "utf8"));

describe("reviewed release notes", () => {
  let repo: string;
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
  const run = (mode: string, version = "0.2.4") => spawnSync(process.execPath, [script, mode, version], {
    cwd: repo, encoding: "utf8",
  });
  const commit = (subject: string) => { git("commit", "--allow-empty", "-qm", subject); };
  const notes = (text: string, version = "0.2.4") => {
    mkdirSync(join(repo, "docs/releases"), { recursive: true });
    writeFileSync(join(repo, `docs/releases/v${version}.md`), text);
  };

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "agav-release-notes-"));
    git("init", "-q", "-b", "main");
    git("config", "user.email", "test@example.invalid");
    git("config", "user.name", "Test");
    commit("initial");
    git("tag", "v0.2.3");
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  it("fails before builds when stable reviewed notes are absent", () => {
    const step = workflow.jobs["check-version"].steps.find((s: any) => s.name === "Validate reviewed release notes");
    expect(step).toBeDefined();
    expect(step.if).toContain("steps.version.outputs.changed == 'true'");
    expect(step.run).toContain("validate");
    expect(workflow.jobs["build-binaries"].needs).toBe("check-version");
    expect(run("validate").status).toBe(1);
    expect(run("validate").stderr).toContain("docs/releases/v0.2.4.md");
  });

  it.each(["", " \n\t", "### Features\n\n<!-- review me -->", "<!-- DRAFT -->\n- unreviewed change"])(
    "rejects empty, placeholder or draft stable notes (%j)", (text) => {
      notes(text);
      expect(run("validate").status).toBe(1);
      expect(run("publish").status).toBe(1);
    },
  );

  it("publishes exact reviewed content after a squash, not the release commit", () => {
    commit("chore(release): release v0.2.4 (#407)");
    const reviewed = "### Features\n\n- A reviewed feature.\n\n### Fixes\n\n- A reviewed fix.\n";
    notes(reviewed);
    const result = run("publish");
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe(reviewed);
    expect(result.stdout).not.toContain("#407");
    expect(run("validate").status).toBe(0);
  });

  it("does not append GitHub's duplicate generated PR section and preserves installation", () => {
    const steps = workflow.jobs.release.steps;
    const publish = steps.find((s: any) => s.name === "Create GitHub Release");
    expect(publish.with.generate_release_notes).toBe(false);
    expect(publish.with.body).toContain("## Installation");
    expect(publish.with.body).toContain("https://www.agav.dev/install.ps1");
    expect(publish.with.body).toContain("Checksum mismatch - refusing to install.");
    expect(steps.find((s: any) => s.id === "notes").run).toContain("publish");
  });

  it("passes multiline notes through the actual workflow output without delimiter collisions", () => {
    const reviewed = "### Fixes\n\n- Keep the literal line below.\nEOF\n- Another fix.\n";
    notes(reviewed);
    const output = join(repo, "github-output");
    const step = workflow.jobs.release.steps.find((s: any) => s.id === "notes");
    // Run the real shell step against a fixture repo and the real script.
    mkdirSync(join(repo, "scripts"));
    writeFileSync(join(repo, "scripts/release-notes.mjs"), readFileSync(script));
    const result = spawnSync("bash", ["-eo", "pipefail", "-c", step.run], {
      cwd: repo, encoding: "utf8",
      env: { ...process.env, CURRENT_TAG: "v0.2.4", GITHUB_OUTPUT: output },
    });
    expect(result.status, result.stderr).toBe(0);
    const written = readFileSync(output, "utf8");
    const delimiter = written.split("\n")[0]!.slice("notes<<".length);
    expect(delimiter).toMatch(/^notes_[0-9a-f-]+$/);
    expect(written).toBe(`notes<<${delimiter}\n${reviewed}${delimiter}\n`);
  });

  it("rejects missing stable notes in the actual prerequisite workflow step", () => {
    mkdirSync(join(repo, "scripts"));
    writeFileSync(join(repo, "scripts/release-notes.mjs"), readFileSync(script));
    const step = workflow.jobs["check-version"].steps.find((s: any) => s.name === "Validate reviewed release notes");
    const result = spawnSync("bash", ["-eo", "pipefail", "-c", step.run], {
      cwd: repo, encoding: "utf8", env: { ...process.env, VERSION: "0.2.4" },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("docs/releases/v0.2.4.md");
  });

  it("prepares a separate draft from the previous stable tag, ignoring betas and excluding release noise", () => {
    commit("feat: new feature");
    git("tag", "v0.2.4-beta.1");
    commit("fix: new fix");
    commit("chore(release): bump version to 0.2.4");
    notes("- Keep my reviewed notes.\n");
    const result = run("prepare");
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain("v0.2.3");
    expect(result.stdout).toContain("DRAFT");
    expect(result.stdout).toContain("### Features");
    expect(result.stdout).toContain("new feature");
    expect(result.stdout).toContain("new fix");
    expect(result.stdout).not.toContain("bump version");
    expect(readFileSync(join(repo, "docs/releases/v0.2.4.md"), "utf8")).toBe("- Keep my reviewed notes.\n");
  });

  it("prepares stable drafts using the stable tree baseline even when it is not a beta ancestor", () => {
    git("checkout", "-qb", "beta", "HEAD");
    commit("feat: already shipped");
    const betaBase = git("rev-parse", "HEAD");
    git("checkout", "main");
    commit("chore(release): previous squash");
    git("tag", "v0.2.3", "-f");
    git("checkout", "beta");
    commit("feat: genuinely new");
    const result = run("prepare");
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain("v0.2.3");
    // A draft cannot know whether a divergent commit already shipped: require review against the tree diff.
    expect(result.stdout).toContain("genuinely new");
    expect(git("merge-base", "--is-ancestor", betaBase, "HEAD")).toBe("");
  });

  it("beta publication uses only the previous applicable ancestor release", () => {
    git("checkout", "-qb", "other");
    commit("feat: unrelated stable");
    git("tag", "v0.9.0");
    git("checkout", "main");
    commit("feat: previous beta");
    git("tag", "v0.2.4-beta.1");
    commit("fix: current beta only");
    git("tag", "v0.2.4-beta.2");
    const result = run("publish", "0.2.4-beta.2");
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("current beta only");
    expect(result.stdout).not.toContain("previous beta");
    expect(result.stdout).not.toContain("unrelated stable");
    expect(run("validate", "0.2.4-beta.2").status).toBe(0);
  });

  it("supports a tagless beta repository without failing on an empty tag list", () => {
    git("tag", "-d", "v0.2.3");
    commit("fix: first beta");
    const result = run("publish", "0.1.0-beta.1");
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("first beta");
  });

  it("requires a stable draft baseline instead of silently replaying all history", () => {
    git("tag", "-d", "v0.2.3");
    expect(run("prepare").status).toBe(1);
    expect(run("prepare").stderr).toContain("stable tag");
  });

  it.each(["../escape", "v0.2.4", "0.2.4\nmalicious"])("rejects invalid versions (%j)", (version) => {
    expect(run("publish", version).status).toBe(1);
    expect(run("publish", version).stderr).toContain("Invalid version");
  });
});
