import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

// GitHub build-provenance attestations prove each released binary was built by
// this repository's release workflow from the release commit. These tests pin
// the workflow wiring so the attestation cannot be silently dropped or scoped
// away from the exact published artifacts.

const root = resolve(import.meta.dirname, "../..");
const workflow = parse(readFileSync(join(root, ".github/workflows/release.yml"), "utf8"));
const build = workflow.jobs["build-binaries"];
const steps = build.steps as any[];
const attest = steps.find((step: any) => String(step.uses ?? "").startsWith("actions/attest-build-provenance"));
const indexOfName = (name: string) => steps.findIndex((step: any) => step.name === name);
const indexOfUses = (prefix: string) => steps.findIndex((step: any) => String(step.uses ?? "").startsWith(prefix));

describe("release build provenance attestations", () => {
  it("attests artifacts on the native build job with the required OIDC/attestation scopes", () => {
    expect(attest).toBeDefined();
    // Pinned action version, not a floating major, so the signing step is fixed.
    expect(attest.uses).toMatch(/^actions\/attest-build-provenance@v\d+\.\d+\.\d+$/);
    expect(attest.if).toBeUndefined();
    expect(attest["continue-on-error"]).toBeUndefined();
    // Attestation requires minting an OIDC token and writing the attestation,
    // on top of the default read. Missing either scope fails the real step.
    expect(build.permissions).toEqual({
      contents: "read",
      "id-token": "write",
      attestations: "write",
    });
  });

  it("attests the exact published artifacts — raw binary and the gzipped variant", () => {
    const subjects = String(attest.with["subject-path"]).split("\n").map((s) => s.trim()).filter(Boolean);
    expect(subjects).toEqual([
      "dist/agav-${{ matrix.target }}${{ matrix.ext }}",
      "dist/agav-${{ matrix.target }}${{ matrix.ext }}.gz",
    ]);
    // Detached metadata is not the artifact and must not be attested as one.
    expect(subjects.some((s) => s.endsWith(".sha256") || s.endsWith(".sig"))).toBe(false);
  });

  it("generates attestations after checksums and before upload, so it binds the shipped bytes", () => {
    const attestIndex = steps.indexOf(attest);
    expect(indexOfName("Generate checksums")).toBeLessThan(attestIndex);
    expect(attestIndex).toBeLessThan(indexOfUses("actions/upload-artifact"));
    // And strictly after the artifact is finalized (built, verified, signed, smoke-tested).
    for (const name of ["Build binary", "Verify the binary embeds the pinned Bun runtime", "Smoke test release binary"]) {
      expect(indexOfName(name)).toBeLessThan(attestIndex);
    }
  });

  it("documents attestation verification in the release notes", () => {
    const releaseSteps = workflow.jobs["release"].steps as any[];
    const createRelease = releaseSteps.find((step: any) => step.name === "Create GitHub Release");
    const body = String(createRelease.with.body);
    expect(body).toContain("gh attestation verify");
    expect(body).toContain("--repo ${{ github.repository }}");
  });
});
