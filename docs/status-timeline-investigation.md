# Status timeline investigation

## Reported behavior

Steer acknowledgements, delivery notices, and the active plan should retain their place in the conversation. Later progress and completed events should appear below them, rather than making an old status look newly emitted.

## Root cause

The scrolling document is shared, but its contents are grouped into separately managed sections rather than chronological entries:

1. `source/app.tsx:1022` renders the completed transcript (`messages`).
2. `source/app.tsx:1024` renders transient command acknowledgements (`systemMessages`).
3. `source/app.tsx:1075` renders the active plan.
4. `source/app.tsx:1115` renders live tool/subagent activity and streaming output.

Every completed assistant message and tool result appends to `messages` in `source/hooks/use-agent.ts:985–1018`. Consequently, new completed events are inserted **above** the unchanged command acknowledgement and plan. Those sections move toward the tail as the transcript grows. This is a rendering/order problem, not evidence that directives are submitted repeatedly.

Slash-command results replace `systemMessages` in `source/app.tsx:885–890`; they are not transcript entries. `steer_applied` independently appends its delivery notice to the transcript in `source/hooks/use-agent.ts:1110–1121`. This can even place a delivery notice above its earlier submission acknowledgement.

The active plan is mutable hook state. Its panel has no transcript anchor, so step status updates and subsequent completed events cannot preserve its original position.

## Delivery scope at initial investigation (before live broadcast follow-up)

The main loop drains steers at a safe conversation boundary after its tool batch finishes (`source/agent/loop.ts:619–637`). Newly spawned subagents capture active directives in their startup system prompt (`source/tools/subagent.ts:124–133`). Already-running subagents do not receive live steer injection; child loops do not receive the main queue callback. This is explicitly covered by `source/__tests__/agent.steer-injection.test.ts`.

This UI fix must not change queue ownership or claim delivery to running children that did not receive it.

## Implementation constraints for the next step

- Put steer/plan command status output into the ordered display timeline rather than the trailing transient section.
- Give the mutable plan panel a stable timeline position and update that entry in place; do not append the entire plan after each new event.
- Keep delivery notices in chronological order and avoid rendering a second copy from a trailing status section.
- Preserve existing live progress, focused subagent inspection, plan detail controls, clear/session-switch behavior, and protocol-safe directive injection.
- Keep UI-only status data separate from model conversation messages.
- Cover multiple steers, command output during running tools/subagents, subsequent assistant/tool completions, plan step updates, and clearing/replacing plans.

## Baseline verification

Read the relevant command, delivery, scrolling, hook-boundary, and progress UI tests before proposing changes. Baseline runs passed without warnings:

- `commands.steer.test.ts`: 5 tests.
- `commands.plan.test.ts`, `agent.steer-injection.test.ts`, `message-list-scroll.test.ts`, `streaming-scroll.test.ts`, `skills.progress-ui.test.ts`: 24 tests.

Those 29 baseline tests did not assert chronological placement of command acknowledgements or the plan panel.

Investigation performed on local branch `fix/status-timeline-order`, created from `beta`. No production source changes were made during the investigation step.

## Implemented behavior and validation

Steer and `/plan` command acknowledgements now append to the display transcript instead of the trailing transient section. The plan panel renders from a display-only transcript entry. Updates to the same plan retain the entry's ID and position; replacing the plan removes the superseded panel, and clearing removes the panel. Model conversation data and steer queue ownership are unchanged.

Regression coverage now checks the latest terminal frame, not accumulated historical paints:

- Multiple steer submissions and delivery notices retain arrival order before later tool results and assistant replies, appearing exactly once.
- Running subagent progress, focused inspection, and returning to overview preserve status order without duplicates.
- The plan panel appears once at its transcript position; pending, in-progress, and done step updates do not move it below later events.
- `/plan` command acknowledgements remain before later completed events and commands.
- Hook-level checks retain the plan anchor during refresh, remove it on clear, and replace it on session activation.

The session-activation regression initially failed because both the old and replacement plan panels remained visible. Removing superseded plan entries fixed the genuine regression; all nine tests in that hook test file then passed.

Final verification:

- Focused UI, hook, commands, agent loop/delivery, scrolling, skills, and subagent suite: **87 tests passed across 14 files**.
- Related planner, transcript, message rendering, and command registry suite: **52 tests passed across 6 files**.
- `pnpm build`, `pnpm typecheck`, and `git diff --check`: passed.
- CLI smoke check printed the expected version, `0.2.3-beta.2`.
- Final runs reported no warnings or unhandled errors. No expected-output fixtures exist for this timeline behavior; terminal-frame assertions explicitly compare order, presence, and multiplicity.

These checks use deterministic terminal rendering with mocked agent boundaries plus the existing real loop/delivery tests. A live provider-backed interactive session and the full repository test suite were not run.

## Follow-up: live subagent steering and named acknowledgements

At the user's request, running built-in `subagent` tool instances now register independent broadcast queues. Each receives new steers without consuming the main queue or another child's queue. The existing loop injects each child's copy at a protocol-safe delivery point. On `steer_applied`, the hook appends a named notice such as `Delivered 1 steer to subagent "Inspect parser".` to the ordered UI transcript. This confirms conversation injection, not proof the model followed the directive; it does not interrupt an in-flight provider request or tool.

Queues start empty (new children still inherit persistent active steers via their startup prompt), are cleared by `/steer clear`, and unregister when the child completes or exits. Skills and native/service agents are not included in this broadcast feature.

Verification includes six real-loop subagent broadcast/lifecycle tests, a real-hook named-acknowledgement test, and latest-frame named-notice ordering checks in overview and focused views. Final focused run: **67 tests passed**; build, typecheck, CLI version smoke check, and diff whitespace checks passed.

A full-suite attempt exposed one outdated sandbox-policy test mock, corrected to include the new queue factory, plus two unrelated macOS sandbox integration failures (`sandbox_apply: Operation not permitted` and a sandbox child unable to start). With only those two integration files excluded, **2,367 tests passed across 159 files**. The excluded files remain unverified in this restricted environment. Negative-fixture loader/generator diagnostics in that broad run are expected test output, not build warnings.
