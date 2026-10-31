# Recovering capacity from uncertain background jobs

An `unknown` or `recovery-required` job has no verified workload outcome. It normally continues to occupy shared background-job capacity (default four jobs), including capacity needed by workflow runners. Age, empty logs, missing IPC or an empty startup nonce do not prove that nothing executed or that descendants stopped.

**Abandonment releases accounting capacity; it does not stop processes or establish success, failure, or safe retry.** It is an explicit operator decision, not automatic recovery.

## Prerequisites

- Use an updated Agav build that lists `abandon` in `agav job help`. Use the same OS user/profile that owns the job store (normally `~/.agav/background-jobs`).
- Enable `backgroundJobsEnabled: true` in the profile's `~/.agav/config.json`. `deny-writes` refuses abandonment; do not bypass your organization's permission policy.
- Review the saved command, working directory, logs, uncertainty reason and external side effects. Identify any linked workflow runner or child job. Keep evidence and an incident record before acting.
- Coordinate with other operators. Updated supervisors honor the startup and publication fence. **Already-running old supervisors do not gain that protection when you upgrade the CLI.** Do not infer termination or kill historical PIDs from this operation.

## Inspect, then explicitly abandon

In an Agav session:

```text
/job list
/job poll FULL-JOB-ID
/job log FULL-JOB-ID
```

The jobs manager also shows details and both log streams. Polling can reconnect or update reconciliation state; it is not a strictly read-only forensic operation. If the supervisor reconnects, prefer observing its actual result or the supported stop path.

Only after accepting that outcome and descendants remain unverified, choose **one** of:

```sh
agav job abandon FULL-JOB-ID --acknowledge-unverified
```

```text
/job abandon FULL-JOB-ID --acknowledge-unverified
```

Replace `FULL-JOB-ID` with the entire stored ID, not the short list prefix. The acknowledgement flag is mandatory for CLI and slash commands. Success reports capacity released and explicitly warns that no processes were stopped and no retry was authorized.

### Interactive jobs manager

1. Open `/job`, select the `recovery-required` or `unknown` job, and press **Enter/i** to inspect details and logs. Review external side effects too.
2. Press **a: Abandon** from the list or detail view. Read the acknowledgement: outcome and descendants remain unverified; no processes will be stopped and no retry is authorized.
3. Press **y** to acknowledge, or **n/Esc** to cancel without writing. This confirmation is required even in `auto-accept` mode. `deny-writes` still refuses the operation.

After successful abandonment, the job disappears from the manager's default **active list**. Jobs abandoned previously through CLI/slash commands are hidden there too. Press **h: Show abandoned** to include retained records, labelled **[abandoned]**; press **h** again to hide them. They remain inspectable, but Stop, Abandon and Delete are not offered for them. `/job list` still includes all stored records and `/job poll FULL-JOB-ID` still shows their audit.

This is a reversible display filter derived from the abandonment tombstone, not permanent archival or deletion. The default active list also includes ordinary terminal history: it is not a count of running processes. An empty list never proves that nothing is running. A fresh reconnect, state change or failed audit write is reported as a refusal/failure, not successful abandonment; the job is not hidden without a durable audit.

## What changes and what stays

- An atomic audit tombstone records the abandonment time, acknowledgement, previous uncertain state and nonce. The job keeps its uncertain lifecycle and existing evidence; abandonment does not synthesize an exit code, end time or completion event.
- Only that job's capacity slot is released. Other uncertain jobs still count. Existing work may still consume real resources, so accounting capacity is not a resource-safety guarantee.
- The tombstone survives restart and is immutable through the updated repository. Repeating the acknowledged operation returns the same audit. The original request ID still returns the original job: it is never redispatched.
- Specs, logs and references are retained. Cleanup and deletion are not recovery shortcuts; an abandoned uncertain job is not eligible for terminal-only deletion. Do not rewrite JSON, remove locks or wipe the profile.
- Updated supervisors check the fence before workload spawn and serialize completion publication with abandonment under the job lock. A late completion after abandonment does not publish a new completion event. This does not stop an already-spawned workload.

## Refusals and failures

A fresh reconnect, changed record (including nonce), known terminal outcome, or held job/coordinator lock prevents abandonment. Inspect again; do not force past evidence or lock checks. Storage publication failure is not success and does not release capacity without the durable audit. Resolve the reported storage/permission issue, inspect the record, and retry the same explicit operation if still appropriate.

## Workflow limitations

Abandonment does not resume a workflow, replace an uncertain runner, retry a child job, or authorize replay of a mutating tool. Runner and child job IDs are distinct; abandoning one does not resolve the other. A queued workflow that never admitted a runner may be able to use ordinary resume after capacity is available, subject to its normal consent and limits. A workflow linked to an uncertain runner or child still needs separate inspection; no automatic force/retry is provided by abandonment. See [Workflows](/reference/workflows).

On Windows the fallback has no Job Object helper and reports unverified ownership. Lost IPC or direct-child termination cannot prove descendant termination. This operation does not remove that limitation.
