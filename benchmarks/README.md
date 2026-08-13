# Benchmarks — Terminal-Bench 2.1

Run a chosen set of [Terminal-Bench 2.1](https://www.tbench.ai) tasks **by name**,
or the whole board for a leaderboard submission.

Terminal-Bench 2.1 is executed through the **Harbor** harness (`harbor run`), using
the dataset `terminal-bench/terminal-bench-2-1`. Everything here is self-contained in
this folder.

## Prerequisites

1. **Docker** running (tasks execute in containers).
2. **Harbor** installed:
   ```bash
   uv tool install harbor      # or: pipx install harbor
   ```
3. **API key** for whatever model/agent you use, e.g.:
   ```bash
   export ANTHROPIC_API_KEY=sk-...
   ```

## Quick start

```bash
# Smoke test the harness works at all (first 5 tasks, no model needed):
harbor run -d terminal-bench/terminal-bench-2-1 -a oracle -l 5
```

## Run specific tasks by name

1. List the task names you want in [`tasks.txt`](./tasks.txt) (one per line), **or**
   pass them as arguments.
2. Run:

   ```bash
   # from repo root:
   ./benchmarks/run-tasks.sh

   # or pass names directly (overrides tasks.txt):
   ./benchmarks/run-tasks.sh some-task-name another-task-name
   ```

## Run the whole board (leaderboard submission)

For an actual leaderboard submission you run **every** task with at least 5
trials each. Use `--all`:

```bash
# All tasks in the dataset, 5 trials each (Terminal-Bench 2.1 minimum):
./benchmarks/run-tasks.sh --all

# Cheap full-board smoke test first (1 trial each) before the real -k 5 run:
EXTRA="-k 1" ./benchmarks/run-tasks.sh --all
```

`--all` drops the per-task filter and defaults to `-k 5`; it can't be combined
with task names (so a stray argument can't silently narrow a submission). After
the run, verify every trial produced a valid ATIF trajectory + reward before
uploading:

```bash
./benchmarks/verify-run.sh          # checks the most recent job under jobs/
```

#### Resumable runs (recommended for the full -k 5)

A full 445-trial run is long, so make it **resumable** by pinning `JOB_NAME`.
Harbor stores the job at `jobs/<JOB_NAME>`; if the run is interrupted (Ctrl-C,
crash, laptop sleep), re-running the **identical** command skips the completed
trials and finishes only the rest — completed work is never re-run or re-billed.

```bash
JOB_NAME=tb21-agav-full ./benchmarks/run-tasks.sh --all   # start (or resume)
# ...interrupted? just run the exact same line again to continue:
JOB_NAME=tb21-agav-full ./benchmarks/run-tasks.sh --all
./benchmarks/verify-run.sh jobs/tb21-agav-full
```

Notes:
- The config must match to resume — keep the command identical (same `-k`,
  model, agent, dataset). Harbor refuses a mismatched resume rather than
  corrupting the job.
- Use a **different** `JOB_NAME` for the `-k 1` smoke test vs the `-k 5` run
  (their configs differ, so they can't share a job dir).
- Without `JOB_NAME`, each run gets a fresh timestamp dir and is **not**
  resumable.

Then upload publicly (see [Upload results](#upload-results-harbor-hub--leaderboard)):

```bash
PUBLIC=1 ./benchmarks/upload.sh
```

### Run on a native amd64 VM (recommended for submission)

The public leaderboard expects **amd64** for consistency. On an Apple-Silicon
(arm64) host, task containers run either arm64-native or amd64-under-emulation —
emulation is slow and can cause timeouts/flakiness that distort scores. So do the
real `-k 5` submission run on a **native amd64 Linux VM**.

You don't need the (private) agav source on the VM: the prebuilt binaries ship in
the bundle, and `build-binary.sh` detects them and skips building. Package once
on this machine:

```bash
benchmarks/package-for-vm.sh        # -> ./agav-benchmarks-vm.tgz (both prebuilt binaries + scripts)
```

Then on an amd64 VM (e.g. Ubuntu, ≥8 vCPU / 16 GB RAM / ~100 GB disk for images)
with **Docker** and **uv** installed:

```bash
scp agav-benchmarks-vm.tgz user@<vm>:~/
ssh user@<vm>
tar -xzf agav-benchmarks-vm.tgz && cd benchmarks
uv venv .venv && source .venv/bin/activate && uv pip install -e agav-agent
export OPENAI_API_KEY=sk-...                 # gpt-5.5 key

cd ..
EXTRA='-k 1' ./benchmarks/run-tasks.sh --all # cheap full-board smoke test first
./benchmarks/verify-run.sh                    # ATIF valid + real cost projection
./benchmarks/run-tasks.sh --all              # the real -k 5 submission run
./benchmarks/verify-run.sh
harbor auth login && PUBLIC=1 ./benchmarks/upload.sh
```

`docker version --format '{{.Server.Arch}}'` on the VM should print `amd64`.

### Finding available task names

The `--include-task-name` filter matches on task **name**. To see what names exist
in the dataset, do a dry run / listing:

```bash
harbor run -d terminal-bench/terminal-bench-2-1 -a oracle --dry-run
```

(or browse the dataset on the Terminal-Bench site / its dataset repo).

## Configuration

`run-tasks.sh` reads these environment variables:

| Var       | Default                          | Meaning                                  |
|-----------|----------------------------------|------------------------------------------|
| `AGENT`   | `agav`                           | Harbor agent (`agav`, or built-ins like `oracle`, `claude-code`) |
| `MODEL`   | `openai/gpt-5.5`            | Model identifier (`provider/model`) passed to the agent |
| `DATASET` | `terminal-bench/terminal-bench-2-1`| Dataset identifier                     |
| `EXTRA`   | *(empty)*                        | Extra flags forwarded to `harbor`, e.g. `-n 2` for parallelism, or `-k 1` to override the trial count |

Examples:

```bash
# Oracle agent just replays the reference solution (good for sanity-checking a task):
AGENT=oracle ./benchmarks/run-tasks.sh my-task

# Run against a real coding agent + model:
AGENT=claude-code MODEL=anthropic/claude-haiku-4-5 ./benchmarks/run-tasks.sh my-task
```

## Benchmarking agav itself

A Harbor agent adapter for agav lives in [`agav-agent/`](./agav-agent). agav has
no published npm package or release binary, and its GitHub repo is private (so it
can't be cloned in-container). Instead, the adapter uses a single-file agav
executable **built from your local checkout** ([`build-binary.sh`](./agav-agent/build-binary.sh)),
uploads it into each task container, and drives it with `agav run "<instruction>"`
— agav's non-interactive mode, which runs one autonomous turn with auto-accept
permissions and exits with a status code.

The binary is a Linux **x64** build (Terminal-Bench 2.0 task images are
amd64/linux). It is built inside an amd64 `oven/bun` container, so it works even
if the host has no `bun`/`node` and native modules resolve for the right target.
`run-tasks.sh` builds it automatically (cached; rebuilt only when sources change)
whenever `AGENT=agav`; you can also build it manually:

```bash
benchmarks/agav-agent/build-binary.sh          # build if missing/stale
FORCE=1 benchmarks/agav-agent/build-binary.sh  # force a rebuild
```

### One-time setup

The adapter and `harbor` must live in the **same** Python environment (the
adapter declares `harbor` as a dependency, so installing it pulls harbor in).
Use one dedicated venv and run everything from it:

```bash
# 1. Create the shared venv and install the adapter (+ harbor) into it:
uv venv benchmarks/.venv
source benchmarks/.venv/bin/activate
uv pip install -e benchmarks/agav-agent

# 2. Verify (uses the venv's python):
python -c "from agav_terminal_bench import AgavAgent; print('adapter ok')"
harbor --version

# 3. Export the provider key agav will use inside the container:
export ANTHROPIC_API_KEY=sk-...        # or OPENAI_API_KEY / GEMINI_API_KEY
```

> Run `run-tasks.sh` from inside this activated venv so it uses the venv's
> `harbor` (the one that can import the adapter).

> **Harbor patch (known issue):** Harbor's `upload_dir` can misplace the
> verifier's `/tests` files if the agent creates a `/tests` dir during a task.
> If you hit verifier failures, apply the one-liner patch documented in the pi
> adapter's README: <https://github.com/badlogic/pi-terminal-bench#required-apply-harbor-fix>

### Run agav on your chosen tasks

```bash
AGENT=agav MODEL=openai/gpt-5.5 ./benchmarks/run-tasks.sh my-task another-task
```

This switches the harness to `-a agav_terminal_bench:AgavAgent`.

Extra knobs (env vars read on the host):

| Var             | Purpose                                                        |
|-----------------|----------------------------------------------------------------|
| `AGAV_MAX_TURNS`| Cap agav's agent iterations per task (e.g. `AGAV_MAX_TURNS=50`) |
| `FORCE`         | `FORCE=1` forces `build-binary.sh` to rebuild the binary        |

The adapter uploads the locally-built `agav-linux-x64` binary into each task
container and runs `agav run "<instruction>"`. To benchmark a specific
commit/branch, check it out locally and re-run (the binary rebuilds when sources
change, or force it with `FORCE=1`).

### Trajectories (ATIF) — required for leaderboard submission

The adapter runs agav with `--trajectory /logs/agent/agav-trajectory.json`, so
each run emits a native transcript (ordered messages, tool calls + results
correlated by id, token usage). After the run, the adapter converts that into a
Harbor **ATIF** `trajectory.json` (`populate_context_post_run`), which the Hub
uploader picks up per trial. The public Terminal-Bench leaderboard CI/judge
audits these trajectories, so agents that upload only free-form logs are
rejected — this is why the conversion exists. Nothing extra to run; it happens
automatically whenever `AGENT=agav`.

## Upload results (Harbor Hub / leaderboard)

Uploads go through [`upload.sh`](./upload.sh), which shares every job with the
**`prapaa`** org by default. (Harbor has no persistent "default org", and
`harbor run` takes no org at all — the org is only ever attached at *upload*
time via `--share-org`, so the default lives here.)

```bash
# Log in once (GitHub OAuth):
harbor auth login

# Upload the most recent job dir, PRIVATE, shared with prapaa (safe default):
./benchmarks/upload.sh

# Upload a specific job dir:
./benchmarks/upload.sh jobs/2026-08-03__18-30-31

# Publish to the PUBLIC leaderboard (real submission):
PUBLIC=1 ./benchmarks/upload.sh jobs/<dir>
```

Visibility defaults to **private** so nothing hits the public leaderboard by
accident — set `PUBLIC=1` for an actual submission.

| Var      | Purpose                                                       |
|----------|--------------------------------------------------------------|
| `ORG`    | Org(s) to share with, space-separated (default: `prapaa`; `ORG=""` = owner only) |
| `PUBLIC` | `PUBLIC=1` → public leaderboard; unset → private             |
| `HARBOR` | Override the `harbor` executable (auto-detected otherwise)    |

The uploaded job is **owned by your user account** (there is no owning-org in
Harbor); `prapaa` gets a *share*. Manage shares later with
`harbor job share <job_id> --org <org>`.

## Notes

- `agav` is the default agent, so `./benchmarks/run-tasks.sh` benchmarks agav
  directly (see the one-time setup above). Use `AGENT=oracle` to sanity-check a
  task with its known-good solution without spending model tokens.
- Results are written to Harbor's run output directory (printed at the end of a run).
