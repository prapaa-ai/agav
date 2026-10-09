# Background-process solution: requirements review

This is the completed requirements review for step 1, not the final solution design. Source: [PR #241 knowledge capture](pr-241-background-process-knowledge.md). The final deliverable will be repository-root `solution.md`.

## Problem and required outcomes

Agav needs a separately owned execution path for approved long-running commands: non-blocking launch, durable bounded logs, trustworthy lifecycle reporting, reconnection after CLI restart, explicit stop, and recurring command schedules that do not require an LLM turn. Preserve the existing short-command tool and prompt schedules.

The implementation must support Linux, macOS, and Windows with the same observable contract, while exposing real platform limitations rather than pretending POSIX semantics are universal. Ordinary CLI exit must leave durable jobs running. Reboot survival, automatic job restart, and cron execution while Agav is closed are separate capabilities, not implicit promises.

## Retain from the earlier proposals

- Durable per-job records and independently owned runners.
- Action-aware permissions, explicit lifetime/resource warnings, and one authorization boundary shared by interactive tools, slash commands, and schedules.
- Bounded log retention, bounded tail reads, unambiguous identifiers, validated inputs, cancellable waits, and immutable/versioned runner assets.
- Feature-gated rollout, platform-specific acceptance criteria, and separation of unrelated changes.

## Update or replace

| Earlier proposal or claim | Corrected requirement |
| --- | --- |
| Check PID existence and quiet logs to decide that a job died. | Quiet jobs are valid. PID reuse makes existence insufficient for identity. Use runner identity/handshake, heartbeat and process creation identity where available; ambiguous evidence must produce an unknown/recovery-required state, not a guessed success or a destructive signal. |
| Mark killed before sending signals to both child and runner. | Model a stop request separately from confirmed termination. Prefer stopping the owned tree through its supervisor; retain the runner long enough to drain logs and record the result. |
| Call termination cleanup during ordinary CLI shutdown. | Remove this recommendation: it contradicts durable-job semantics. Shutdown disconnects the UI; explicit stop controls job termination. |
| Stamp notification first to guarantee delivery once. | Stamp-first can lose messages; notify-first can duplicate them. Use durable completion events, idempotent presentation and acknowledged delivery. State guarantees explicitly; a timestamp alone cannot provide exactly-once delivery. |
| Atomic JSON rename solves state consistency. | It prevents partial publication, not lost updates between writers. Give authoritative lifecycle state one writer; separate immutable launch specifications, stop requests, and notification acknowledgements. Account for crash recovery, flushes, Windows sharing failures and concurrent clients. |
| Rename an active log and start another file. | The child may keep writing to the old descriptor on Unix, and Windows may prevent rename. The runner must own log output and close/reopen segments safely; enforce byte limits even for a single very long line. |
| Prefer stdout in all completion summaries. | Show bounded, labelled excerpts from both streams, weighted by outcome, without dropping warnings or the actual result. |
| A Boolean approval marker or another regex check secures the runner. | Neither is an authorization boundary against writable local state. Bind grants to the full launch specification and validated ownership; reject altered requests. Regex checks are warnings/defence in depth, not a shell security model. |
| Sandbox auto-selection supplies equivalent protection on all OSes. | Detect actual backend capabilities and resolve isolation before approval. Unsupported required isolation must fail closed; explicitly approved unsandboxed execution is a distinct mode. Windows Job Objects provide process ownership/resource control, not filesystem or network sandboxing. |
| A project-only working directory prevents external access. | It reduces accidental misuse but is not containment. Resolve links/junctions and disclose outside-project directories; filesystem/network access must be enforced by isolation policy where supported. |
| Anchoring a secret-name regex is sufficient environment control. | Define a minimal environment, platform-specific essentials and explicit optional inheritance. Filter risky runtime-injection variables and support consented credential references without persisting values. Normalize environment names correctly on Windows. |

## Evidence corrections and limits

The existing knowledge capture overstates several observations. Its runnable probes reconstructed one module with substituted dependencies; they do not establish end-to-end behavior of the original PR or all three platforms. Preserve those observations as exploratory evidence, not a production compatibility certification.

- No-log-growth is not a heartbeat or proof of death.
- Metadata-only poll/list operations need not read logs; the original claim that every poll reads a whole log is too broad. The bounded-read requirement applies to log reads and completion excerpts.
- Arbitrary commands do not become safe because they use an approved working directory or lose some environment variables.
- A shell regex blocklist is incomplete, but the earlier document's individual bypass examples were not established reliably; do not reuse them as proven demonstrations.
- Accepting a user-created schedule is not itself evidence of prompt-injected remote code execution. The confirmed design gap is divergent authorization paths and absent trigger-time policy enforcement.
- Sandboxing is not inherently incompatible with dev servers; permitted ports/network access are isolation-policy decisions.
- The PR was never merged, so these are requirements for introducing the feature, not fixes to an existing production process tool.

## Platform constraints to carry into the design

| Concern | Linux and macOS | Windows |
| --- | --- | --- |
| Detached lifetime | Separate session/process group and independent standard streams; login/service-manager policy can still end jobs. | Independent detached runner with no inherited UI pipes; inherited Job Objects can constrain lifetime. |
| Process-tree ownership | Process groups support ordinary descendants; descendants can escape. Stronger Linux containment can use cgroups where available; macOS requires an explicitly scoped ownership strategy. | A Windows Job Object requires a native platform adapter and launch/assignment discipline; plain PID termination is not a reliable tree stop. |
| Stop behavior | Grace period followed by supported group/tree termination and verified outcome. | Application-level graceful shutdown where supported; otherwise clearly disclosed forced tree termination. Do not equate signal names with POSIX graceful behavior. |
| Shell | Default POSIX shell is not necessarily Bash. | cmd.exe and PowerShell have different grammars; package-manager batch shims require explicit handling. |
| Isolation | Bubblewrap availability and namespace restrictions vary; macOS Seatbelt tooling must be detected and supported deliberately. | No native equivalent of the existing Unix sandbox backends; process ownership must not be advertised as security isolation. |
| Persistence | Same-filesystem publication plus a declared durability strategy; restrictive user permissions. | Sharing violations, ACLs, path casing, drive/UNC paths and junctions require explicit treatment. |

## Open design choices for step 2

Select a practical baseline for process-tree control, scheduling ownership across multiple sessions, durable event delivery, storage concurrency and Windows runner packaging. Define what is guaranteed, what is best-effort and what is unavailable. Keep the design independent of source-code implementation details.

## Review status

The source knowledge capture was read in full. An independent cross-platform assessment supplied the constraints above; a second independent reassessment timed out. No production code was modified and no project test suite was run. This artifact records the completed requirements review and the changes required to the earlier recommendations.
