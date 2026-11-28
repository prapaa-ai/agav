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
    // Pin the action to a full commit SHA (not a floating tag), matching the
    // repo convention for third-party actions, with the human version in a
    // trailing comment. A bare `@vX.Y.Z` tag is rejected so a non-existent or
    // mutable ref cannot slip in.
    expect(attest.uses).toMatch(/^actions\/attest-build-provenance@[0-9a-f]{40}$/);
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

  it("records the human-readable version alongside the SHA pin", () => {
    // YAML drops comments, so assert the `# vX.Y.Z` annotation in the raw file.
    const raw = readFileSync(join(root, ".github/workflows/release.yml"), "utf8");
    expect(raw).toMatch(/actions\/attest-build-provenance@[0-9a-f]{40} # v\d+\.\d+\.\d+/);
  });

  it("documents verification constrained to the signer workflow and source commit", () => {
    const releaseSteps = workflow.jobs["release"].steps as any[];
    const createRelease = releaseSteps.find((step: any) => step.name === "Create GitHub Release");
    const body = String(createRelease.with.body);
    expect(body).toContain("gh attestation verify");
    expect(body).toContain("--repo ${{ github.repository }}");
    // Repo-only verification would accept provenance from any workflow or commit
    // in the repo; pin both the signer workflow and the source commit.
    expect(body).toContain("--signer-workflow ${{ github.repository }}/.github/workflows/release.yml");
    expect(body).toContain("--source-digest ${{ github.sha }}");
  });
});

// The release publishes two SBOMs, the production graph and the separate
// dev/build graph, each with its own Sigstore SBOM attestation. Pin that wiring
// so neither can be dropped or generated from anything but the release commit.
describe("release SBOM attestations", () => {
  const sbom = workflow.jobs["sbom"];
  const sbomSteps = sbom.steps as any[];
  const version = "${{ needs.check-version.outputs.version }}";
  const files = [`agav-sbom-${version}.cdx.json`, `agav-build-sbom-${version}.cdx.json`];
  const attests = sbomSteps.filter((step: any) => String(step.uses ?? "").startsWith("actions/attest-sbom"));

  it("generates both SBOMs from the release commit and the frozen lockfile", () => {
    const checkout = sbomSteps.find((step: any) => String(step.uses ?? "").startsWith("actions/checkout"));
    expect(checkout.with.ref).toBe("${{ github.sha }}");
    const install = sbomSteps.findIndex((step: any) => step.run === "pnpm install --frozen-lockfile");
    const runs = sbomSteps.map((step: any) => String(step.run ?? ""));
    const prod = runs.findIndex((run) => run === 'node scripts/gen-sbom.mjs "agav-sbom-${VERSION}.cdx.json"');
    const build = runs.findIndex((run) => run === 'node scripts/gen-sbom.mjs --dev "agav-build-sbom-${VERSION}.cdx.json"');
    expect(install).toBeGreaterThan(sbomSteps.indexOf(checkout));
    expect(prod).toBeGreaterThan(install);
    expect(build).toBeGreaterThan(install);
  });

  it("attests each SBOM on its own, pinned, with the required scopes, before upload", () => {
    expect(sbom.permissions).toEqual({ contents: "read", "id-token": "write", attestations: "write" });
    expect(attests.map((step: any) => step.with["sbom-path"])).toEqual(files);
    const upload = sbomSteps.findIndex((step: any) => String(step.uses ?? "").startsWith("actions/upload-artifact"));
    for (const step of attests) {
      expect(step.uses).toMatch(/^actions\/attest-sbom@[0-9a-f]{40}$/);
      expect(step.with["subject-path"]).toBe(step.with["sbom-path"]);
      expect(step.if).toBeUndefined();
      expect(step["continue-on-error"]).toBeUndefined();
      expect(sbomSteps.indexOf(step)).toBeLessThan(upload);
    }
    const uploaded = String(sbomSteps[upload].with.path).split("\n").map((s) => s.trim()).filter(Boolean);
    expect(uploaded).toEqual(files.flatMap((file) => [file, `${file}.sha256`]));
  });

  it("refuses to publish the release without either SBOM or its checksum", () => {
    const prepare = (workflow.jobs["release"].steps as any[]).find((step: any) => step.name === "Prepare release assets");
    const script = String(prepare.run);
    expect(script).toContain('BUILD_SBOM="agav-build-sbom-${VERSION}.cdx.json"');
    expect(script).toContain('for required in "$SBOM" "$SBOM.sha256" "$BUILD_SBOM" "$BUILD_SBOM.sha256"; do');
  });
});
