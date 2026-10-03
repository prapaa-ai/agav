# Dependency update audit

Reviewed on 2026-10-03. Updates are local on `chore/docs-and-deps-update`; open Dependabot PRs were read-only inputs. No PR was edited, commented on, rebased, closed, or pushed.

## Open Dependabot coverage

| PR | Package | Selected version |
| --- | --- | --- |
| [#352](https://github.com/prapaa-ai/agav/pull/352) | `@alcalzone/ansi-tokenize` | 0.3.1 |
| [#354](https://github.com/prapaa-ai/agav/pull/354) | `slice-ansi` | 9.0.1 |
| [#355](https://github.com/prapaa-ai/agav/pull/355) | `tsx` | 4.23.15 |
| [#396](https://github.com/prapaa-ai/agav/pull/396) | `openai` | 7.27.0, newer compatible release than PR target 7.23.0 |
| [#397](https://github.com/prapaa-ai/agav/pull/397) | `chalk` | 6.0.1 |
| [#398](https://github.com/prapaa-ai/agav/pull/398) | `@anthropic-ai/sdk` | 0.131.0, newer than PR target 0.129.0 |
| [#399](https://github.com/prapaa-ai/agav/pull/399) | `@types/node` | 26.6.4, newer than PR target 26.6.3 |

Also refreshed compatible CLI dependencies (`ollama`, `string-width`, `yaml`, React 19.2 patches), docs dependencies, the release Worker toolchain, and transitive lockfile resolutions. Worker dependencies now have an independent pnpm lockfile and workspace/build-script allowlist; its existing runtime compatibility date is unchanged.

## Security

Registry audits include development dependencies, not only production:

| Project | Before | After |
| --- | --- | --- |
| CLI | 1 critical, 18 high, 9 moderate | No known audit vulnerabilities |
| Docs | 3 critical, 8 high, 2 moderate, 1 low | 1 high, development-only `braces` |
| Release Worker | No reproducible prior isolated lockfile; parent-directory audit was not a valid Worker baseline | No known audit vulnerabilities |

Key patched packages:

- Next **16.3.8**, paired with `eslint-config-next` **16.3.8**: addresses critical findings [GHSA-p293-qw3h-jr36](https://github.com/advisories/GHSA-p293-qw3h-jr36), [GHSA-2xp9-vwfh-vxw4](https://github.com/advisories/GHSA-2xp9-vwfh-vxw4), and [GHSA-vcvr-r3jv-pc5j](https://github.com/advisories/GHSA-vcvr-r3jv-pc5j), plus subsequent security fixes in the [16.3.8 release](https://github.com/vercel/next.js/releases/tag/v16.3.8). Upgrading browser React alone does not patch Next's server-component implementation.
- Vitest and V8 coverage **4.1.11**: fixes [GHSA-5xrq-8626-4rwp](https://github.com/advisories/GHSA-5xrq-8626-4rwp) and [GHSA-82fw-gwwq-j7x9](https://github.com/advisories/GHSA-82fw-gwwq-j7x9). Retaining Vitest 3 would not address the latter.
- Sharp **0.35.5** fixes [GHSA-rgj7-g3m4-5g8c](https://github.com/advisories/GHSA-rgj7-g3m4-5g8c).
- Transitive refresh patches `fast-uri`, `js-yaml`, DOMPurify, PostCSS, Nano ID, and brace-expansion (including v5 **5.0.12**), preserving compatible major APIs. No dependency override or audit suppression remains. Frozen lockfile compatibility was also checked using the CI's pnpm 9 in an isolated directory.
- Reviewed known compromised releases: Chalk **5.6.1** and slice-ansi **7.1.1** are not selected. No new runtime package was added. Audit success means no known registry-reported vulnerability, not a guarantee against undiscovered flaws.

### Unresolved advisory

[GHSA-vfj7-8cjw-p6xm / CVE-2026-93687](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm): `braces` **3.0.3** nested-pattern denial of service, reached through `eslint-config-next → @next/eslint-plugin-next → fast-glob → micromatch → braces`. This is a development/lint dependency, not the exported site's runtime. The advisory names **3.0.4**, but the live registry did not publish that version at review time. No nonexistent-version override or audit suppression was added. Avoid passing attacker-controlled glob patterns to this chain, and refresh once an upstream patch is published.

## Breaking-change decisions

- Chalk 6 requires Node 22, compatible with Agav's Node **>=22.13.0** floor. Numeric `FORCE_COLOR` now requests an exact level; 256-color styles downsample on 16-color terminals. Existing styling APIs remain supported.
- Anthropic 0.129 removed beta SDK tool-runner `compactionControl`; Agav does not use that API. Its own compaction is unchanged. SDK model deprecations are not silently converted into default-model changes.
- Vitest 4 moved worker configuration to top-level `maxWorkers`. Kept the `forks` pool with four workers because tests use `process.chdir()`. Updated affected tests to explicitly reset mock implementations, preserving their assertions. Relocated the existing agent-loop test into `__tests__` before updating its precise mock type.
- Kept React **19.2.8**, reconciler **0.33.0**, and scheduler **0.27.0** together; did not migrate terminal renderer host APIs to React 19.3/reconciler 0.34. Pinned `@types/react-reconciler` **0.33.0** because 0.33.1 changes host-config signatures and fails this renderer's typecheck.
- Kept Marked **15.0.12**: `marked-terminal` declares `marked >=1 <16`; upgrading to Marked 18 would violate that peer contract.
- Kept TypeScript **5.9.3**, ESLint **9.39.5**, Mermaid **11.17.2**, and Vitest **4.1.11** rather than unrelated compiler/linter/diagram/test-runner migrations. Current ESLint plugins do not declare ESLint 10 compatibility; TypeScript 7 is outside the parser's supported range; Mermaid 12 changes rendering defaults and browser/runtime requirements. ESLint 9's upstream unsupported-version warning remains a tracked tooling limitation.
- Pinned docs `lucide-react` to **1.49.0**, an aged stable release, rather than bypassing the package manager's release-age policy for a same-day icon release. Cloudflare tooling's explicit recent-release exceptions are scoped to the selected Wrangler/Workers types versions; build-script approvals are scoped to esbuild/workerd.

## Verification

Verification passed:

- **1,246 CLI tests across 122 files**, including nine new real-SDK offline transport tests for streamed tool arguments, gateway query parameters, and cancellation.
- **8 Worker tests**, Worker typecheck, audit, and Wrangler deployment **dry-run**; no deployment occurred.
- Root and docs typechecks; TypeScript compilation to a temporary directory; Bun-compiled CLI `--version` and `--help` smoke checks.
- Docs-site ESLint and static production build: **60 generated routes**. Full docs lint retains only the preexisting Worker-source warning below.
- Frozen installs and `git diff --check`; isolated pnpm 9 docs lockfile compatibility.

No deployment or paid provider request was performed.

The existing Worker anonymous-default-export lint warning is unchanged. The docs Dockerfile's npm lockfile assumptions are preexisting and were not used to claim Docker verification. Real network/provider behavior, real Windows cleanup, and cross-platform binary execution still require their normal CI/integration coverage.
