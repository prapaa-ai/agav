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
    // build-binaries runs after check-version (the notes gate blocks builds);
    // it also depends on dependency-audit, so assert membership not equality.
    expect(workflow.jobs["build-binaries"].needs).toContain("check-version");
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
    writeFileSync(join(repo, "docs/releases/v0.2.4.contributors.json"), JSON.stringify(["@contributor"]));
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

  it("requires reviewed stable contributors and rejects invalid metadata", () => {
    notes("- Reviewed change.\n");
    expect(run("validate").stderr).toContain("v0.2.4.contributors.json");
    expect(run("contributors").status).toBe(1);
    for (const content of ["not JSON", "{}", '[null]', '[" "]', '["line\\nbreak"]']) {
      writeFileSync(join(repo, "docs/releases/v0.2.4.contributors.json"), content);
      expect(run("validate").status).toBe(1);
      expect(run("contributors").status).toBe(1);
    }
  });

  it("preserves reviewed stable credits after squash without replaying historical people", () => {
    notes("- Reviewed change.\n");
    writeFileSync(join(repo, "docs/releases/v0.2.4.contributors.json"), JSON.stringify(["@new", "@returning", "@NEW"]));
    commit("chore(release): stable squash\n\nCo-authored-by: Old <old@example.invalid>");
    const result = run("contributors");
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("## Contributors\n\nThank you to everyone who contributed to this release!\n\n- @new\n- @returning\n");
    expect(result.stdout).not.toContain("Old");
    expect(run("validate").status).toBe(0);
  });

  it("credits beta authors and final coauthors once, excluding bots and the previous release", () => {
    git("config", "user.name", "Already shipped");
    commit("feat: previous beta");
    git("tag", "v0.2.4-beta.1");
    git("config", "user.name", "Alice");
    git("config", "user.email", "123+alice@users.noreply.github.com");
    commit("fix: current change\n\nCo-authored-by: Historical <old@example.invalid>\n\nNot a final trailer.\n\nCo-authored-by: Bob <bob@example.invalid>\nCo-authored-by: Alice <123+alice@users.noreply.github.com>\nCo-authored-by: dependency[bot] <bot@example.invalid>");
    commit("chore(release): bump version to 0.2.4-beta.2");
    git("tag", "v0.2.4-beta.2");
    const result = run("contributors", "0.2.4-beta.2");
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("## Contributors\n\nThank you to everyone who contributed to this release!\n\n- @alice\n- Bob\n");
    expect(result.stdout).not.toContain("example.invalid");
  });

  it("keeps distinct people with the same name and never treats display names as handles", () => {
    commit("fix: contributed\n\nCo-authored-by: Alex <one@example.invalid>\nCo-authored-by: Alex <two@example.invalid>\nCo-authored-by: @unrelated <three@example.invalid>\nCo-authored-by: Claude Opus 5.5 <noreply@anthropic.com>");
    const result = run("contributors", "0.2.4-beta.1");
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.match(/^- Alex$/gm)).toHaveLength(2);
    expect(result.stdout).toContain("- \\@unrelated");
    expect(result.stdout).not.toContain("Claude");
  });

  it("prepares a separate contributor draft without modifying reviewed files", () => {
    commit("feat: beta contribution\n\nCo-authored-by: Alice <alice@users.noreply.github.com>");
    git("tag", "v0.2.4-beta.1");
    notes("- Reviewed.\n");
    const path = join(repo, "docs/releases/v0.2.4.contributors.json");
    writeFileSync(path, '["@reviewed"]');
    const result = run("prepare-contributors");
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(["@alice", "Test"]);
    expect(readFileSync(path, "utf8")).toBe('["@reviewed"]');
    git("tag", "-d", "v0.2.3");
    expect(run("prepare-contributors").status).toBe(1);
  });

  it("handles tagless betas, escapes Markdown names, and omits an empty section", () => {
    expect(run("contributors", "0.2.4-beta.1").stdout).toBe("");
    git("tag", "-d", "v0.2.3");
    git("config", "user.name", "[Person](https://example.invalid)");
    commit("docs: contribution");
    const result = run("contributors", "0.2.4-beta.1");
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("- \\[Person\\]\\(https://example.invalid\\)");
  });

  it("passes contributor output through the real workflow and puts it last on the release page", () => {
    const step = workflow.jobs.release.steps.find((s: any) => s.id === "contributors");
    const publish = workflow.jobs.release.steps.find((s: any) => s.name === "Create GitHub Release");
    expect(publish.with.body.trimEnd()).toMatch(/\$\{\{ steps.contributors.outputs.contributors \}\}$/);
    expect(publish.with.body.indexOf("steps.contributors.outputs")).toBeGreaterThan(publish.with.body.indexOf("</details>"));
    notes("- Reviewed.\n");
    writeFileSync(join(repo, "docs/releases/v0.2.4.contributors.json"), '["@alice", "EOF"]');
    mkdirSync(join(repo, "scripts"));
    writeFileSync(join(repo, "scripts/release-notes.mjs"), readFileSync(script));
    const output = join(repo, "github-output");
    const result = spawnSync("bash", ["-eo", "pipefail", "-c", step.run], {
      cwd: repo, encoding: "utf8",
      env: { ...process.env, CURRENT_TAG: "v0.2.4", GITHUB_OUTPUT: output },
    });
    expect(result.status, result.stderr).toBe(0);
    const written = readFileSync(output, "utf8");
    const delimiter = written.split("\n")[0]!.slice("contributors<<".length);
    expect(delimiter).toMatch(/^contributors_[0-9a-f-]+$/);
    expect(written).toBe(`contributors<<${delimiter}\n${run("contributors").stdout}${delimiter}\n`);
    rmSync(join(repo, "docs/releases/v0.2.4.contributors.json"));
    const failure = spawnSync("bash", ["-eo", "pipefail", "-c", step.run], {
      cwd: repo, encoding: "utf8",
      env: { ...process.env, CURRENT_TAG: "v0.2.4", GITHUB_OUTPUT: output },
    });
    expect(failure.status).not.toBe(0);
    expect(readFileSync(output, "utf8")).toBe(written);
  });

  it.each(["../escape", "v0.2.4", "0.2.4\nmalicious"])("rejects invalid versions (%j)", (version) => {
    expect(run("publish", version).status).toBe(1);
    expect(run("publish", version).stderr).toContain("Invalid version");
  });
});
