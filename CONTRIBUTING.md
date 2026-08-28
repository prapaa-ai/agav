# Contributing to Agav

Thanks for helping improve Agav. This guide covers everything you need to get started.

## Prerequisites

- **Node.js 22+** and **pnpm 9**
- **Bun** (for binary builds)

```bash
pnpm install --frozen-lockfile
```

## Project structure

```
source/
├── agent/          # Agent loop, planner, conversation state
├── commands/       # Slash commands (/help, /model, /steer, etc.)
├── components/     # Ink/React terminal UI components
├── config/         # Config loading, keybindings, scheduler, history
├── hooks/          # React hooks (use-agent, use-paste-handler)
├── mcp/            # MCP server integration
├── plugins/        # Plugin system
├── providers/      # LLM providers (Anthropic, OpenAI, Gemini, Vertex AI, Ollama)
├── skills/         # Skill system (loader, executor, bundled skills)
├── tools/          # Agent tools (file read/write, shell, grep, etc.)
├── utils/          # Shared utilities (sandbox, diff, encrypt, etc.)
├── app.tsx          # Main UI composition
├── cli.tsx          # CLI entry point
├── main.tsx         # CLI arg parsing, startup logic
└── version.ts       # Version (reads from package.json)
```

## Development workflow

### Fork and clone

Non-maintainers don't have push access to this repository, so you'll need to fork it first:

1. Click **Fork** on the [GitHub repo page](https://github.com/prapaa-ai/agav)
2. Clone your fork locally:
   ```bash
   git clone https://github.com/<your-username>/agav && cd agav
   pnpm install --frozen-lockfile
   ```
3. Create a branch for your change:
   ```bash
   git checkout -b feat/my-change
   ```
4. When you're ready, push to your fork and open a PR against `beta`

> **Note:** The `main` branch is protected — only maintainers merge `beta → main` to cut stable releases or push hotfixes directly. All external contributions go through `beta`.

### Local checks before opening a PR

```bash
pnpm build              # Compile TypeScript
npx tsc --noEmit        # Type check
npx vitest run          # Run tests
pnpm start              # Run from source
pnpm build:binary       # Build standalone binary (requires Bun)
```

### Running Agav from source

```bash
pnpm start                              # Interactive mode
pnpm start -- -P "your prompt"          # Pipe mode
pnpm start -- run "your prompt"         # Non-interactive agent mode
pnpm start -- --provider gemini         # Use a specific provider
```

### Adding a new tool

1. Create `source/tools/your-tool.ts` implementing `ToolDefinition`
2. Register it in `source/tools/registry-factory.ts`
3. Add a display label in `source/utils/tool-labels.ts`
4. Add tests in `source/__tests__/`

### Adding a new provider

1. Create `source/providers/your-provider.ts` implementing `LLMProvider`
2. Add to `source/providers/registry.ts` switch
3. Add config fields in `source/config/config.ts`
4. Update `source/main.tsx` (flags, validation, auto-detection, help text)
5. Add model entries in `source/commands/model-routing.ts`
6. Add model fetching in `source/commands/model.ts`
7. Update session restoration in `source/main.tsx` and `source/commands/history.ts`
8. Update provider memoization in `source/app.tsx` and add provider/config tests

### Adding a new slash command

1. Create `source/commands/your-command.ts` implementing `SlashCommand`
2. Register in `source/commands/registry.ts` constructor

## CI pipeline

### PR checks (blocking)

All checks must pass before merge. Change-aware — skips irrelevant jobs:

| Check | Runs when |
|---|---|
| Type Check | source or deps changed |
| Build Check | source or deps changed |
| Tests | source or deps changed |
| PR Title Lint | always |
| Secret Scan | always |
| Blob Size (max 512KB) | always |
| Dangerous Patterns | always |
| Semgrep SAST | source changed |
| Dependency Audit | deps changed |
| Lockfile Integrity | deps changed |
| Sensitive File Check | always |

A terminal `All Checks` job gates the merge — set this as your only required status check.

### Post-merge checks (non-blocking)

Runs on push to `main`:
- Full test suite with clean worktree check
- Binary smoke test (build + verify)
- License compliance
- SBOM generation
- Container image scan
- Dependency pinning check
- Commit signing verification

### AI-powered workflows

Agav dogfoods itself in CI:

| Workflow | Trigger | What it does |
|---|---|---|
| PR Review | PR opened/synced | Reviews diff, posts comment |
| PR Labeler | PR opened/synced | Auto-labels (bug/feature/ci/etc) |
| Issue Triage | Issue opened | Labels issues |
| Duplicate Detection | Issue opened | Finds duplicate issues |
| Issue Translator | Issue opened | Translates non-English issues |
| Docs Update | Every 12h | Updates README from recent commits |
| Stale PR Closer | Daily | Closes PRs inactive 14+ days |

### Release

Triggered by version bump in `package.json` on `main` or `beta` branches:
1. Builds binaries for 5 platforms (darwin-arm64, darwin-x64, linux-x64, linux-arm64, windows-x64)
2. Signs binaries (macOS codesign, Linux cosign)
3. Compresses binaries (gzip) and generates SHA256 checksums
4. Creates GitHub release with assets

**Two-branch release model:**

| Branch | Version format | Release type |
|---|---|---|
| `beta` | `x.y.z-beta.N` (e.g. `0.2.0-beta.1`) | GitHub Pre-release |
| `main` | `x.y.z` (e.g. `0.2.0`) | GitHub Latest release |

**Typical release flow:**

```
main (0.1.9)                          ← current stable
  │
  ├── beta branch (created from main)
  │     ├── PR → beta, bump to 0.2.0-beta.1  → Pre-release
  │     ├── PR → beta, bump to 0.2.0-beta.2  → Pre-release
  │     └── PR → beta, no version bump        → no release
  │
  ├── PR: beta → main, bump to 0.2.0         → Stable release
  │
  ├── beta branch (reset from main)
  │     └── ...next cycle...
```

- **Pre-releases** are visible on the releases page but not served by `install.sh` by default
- **Stable releases** become the Latest release and are served by `install.sh`
- The `beta → main` merge and hotfixes to `main` are **maintainer-only** operations
- Hotfixes can go directly to `main` with a patch bump (e.g. `0.2.1`)

**Installing a beta version:**

```bash
# macOS / Linux
curl -fsSL https://agav.dev/install.sh | bash -s -- --beta

# Windows
irm https://www.agav.dev/install.ps1 | iex -- --beta

# Or via environment variable
AGAV_BETA=1 curl -fsSL https://agav.dev/install.sh | bash
```

## Pull requests

- **Title format**: Use conventional commits — `feat:`, `fix:`, `refactor:`, `docs:`, `chore:`, `test:`, `perf:`, `ci:`
- **Description**: Explain the user-visible change and any tradeoffs
- **Scope**: Keep PRs focused. One feature or fix per PR when possible
- **Tests**: Add tests for new functionality. Don't modify production code to make tests pass

## Code guidelines

- TypeScript strict mode
- No comments unless the WHY is non-obvious
- Prefer editing existing files over creating new ones
- Don't add features beyond what the task requires
- Security: no `eval()`, no template literal shell exec, no disabled TLS (except `cli.tsx`)

## Testing

```bash
npx vitest run                    # Run all tests
npx vitest run source/__tests__   # Run only unit tests
pnpm test:coverage                # Run with coverage report
```

Test files go in `source/__tests__/`. Name them `<module>.test.ts`.

When writing tests:
- Test the existing behavior of the code
- Never modify production source to make tests pass
- Mock external dependencies (filesystem, network, child processes)

## Ways to contribute

Every contribution matters — code is just one of many ways to make Agav better:

### Report bugs
- Open an issue with a clear title and steps to reproduce
- Include your OS, Node version, provider, and model
- Paste the error message or screenshot
- Mention what you expected vs what happened

### Suggest features
- Open an issue with the `feature` label
- Describe the problem you're trying to solve, not just the solution
- Include examples of how you'd use the feature

### Improve documentation
- Fix typos, unclear wording, or outdated instructions in README.md or CONTRIBUTING.md
- Add examples for commands or workflows you found confusing
- Translate docs into other languages
- Contribute to the **[documentation website](https://docs.agav.dev)** — the source is in the [`docs/`](docs/) directory (a Next.js app with Markdown content). Guides, reference pages, and workflow examples are all welcome

### Test and give feedback
- Try Agav with different providers (Anthropic, OpenAI, Gemini, Vertex AI, Ollama) and report issues
- Test on different platforms (macOS, Linux, WSL)
- Try edge cases — large files, long conversations, unusual prompts
- Report UI glitches, confusing output, or missing feedback

### Help with issues
- Reproduce bugs others reported and add your findings
- Answer questions from other users
- Label or triage issues if you have access

### Spread the word
- Star the repo
- Share Agav with colleagues who use terminal-based workflows
- Write a blog post or tutorial about your setup

## Safety checklist

Before committing, verify:

- [ ] No secrets or `.env` files
- [ ] No files over 512KB
- [ ] No `eval()` or `new Function()`
- [ ] No shell exec with template literals
- [ ] No generated build output (`build/` directory)
- [ ] `npx tsc --noEmit` passes
- [ ] `npx vitest run` passes
