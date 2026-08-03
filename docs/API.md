# MoA localhost API

The service binds only to `127.0.0.1`. State-changing requests accept only the local MoA origins, request bodies are bounded, and run/workspace paths are validated on the server.

Active workflow records returned by `GET /api/status` include `stage`, `startedAt`, and `lastActivityAt`. Completed workflow and execution records are persisted separately as `workflow.status.json` and `execution.status.json`, allowing the client to recover a deterministic terminal state after refresh or SSE reconnection. Inactivity and maximum-runtime stops use explicit reasons (`workflow_idle_timeout`, `workflow_maximum_runtime`, `idle_timeout`, or `maximum_runtime`) rather than leaving an active record behind.

## Execute a judged run

`POST /api/execute` accepts `{ "runName": "saved-run-directory" }`. Execution is a one-time transition, not a retry endpoint. A run is eligible only when its normalized manifest state is exactly `awaiting_execution`, `judge.md` is non-empty, Execute and Verify have not started, and no execution status, report, attempt, Git baseline, or workspace ledger already exists.

Schema-v2 runs additionally require Initialize, Plan, Explore, Consolidate, and Judge to be complete, with Execute and Verify pending. Schema-v1 runs remain compatible when they claim `awaiting_execution`, have a plan and no execution footprint, and any stage metadata they contain does not contradict those facts. Missing or incompatible manifests are never repaired or inferred.

The endpoint evaluates eligibility before and after claiming the single admission slot. Rejection does not create, truncate, or rewrite run artifacts and does not launch a process:

- `409 run_not_awaiting_execution`: the lifecycle is not at the one-time execution boundary
- `409 judge_not_complete`: the plan or required prior stages are incomplete
- `409 run_already_attempted`: execution evidence exists or Execute/Verify are not pending
- `422 invalid_run_manifest`: the manifest is missing, malformed, incompatible, or corrupted

After any attempted or terminal execution, use `POST /api/runs/:name/resume` with an explicit continuation instruction. The parent is immutable; retry work belongs to a linked new revision. Bounded corrective Execute/Verify passes and bounded Judge revisions remain within the one admitted execution attempt and do not make the endpoint replayable.

Terminalization writes final Git evidence, terminal stage state, and the atomic terminal status before finalizing the manifest. The resulting artifact inventory includes the terminal status and lifecycle event, excludes `run.json`, and records hashes of the exact terminal bytes. Workflow success refreshes the artifact inventory after writing `workflow.status.json` without appending a duplicate terminal event. A provenance-finalization failure is reported as `finalization_failed`, releases admission, and is never reported as verified completion.

## Correct an actionable verification failure

Verify always runs after a successful Executor. A passing report completes unchanged, while a non-actionable failure terminates with `verification_failed`. Only a verifier report that explicitly declares a concrete bounded correction and supplies the required summary, findings, scope, affected areas, and Judge-impact fields transitions to `awaiting_correction_approval`.

The complete approval payload is written atomically to `execution.status.json` and `correction-approval-attempt-<n>.json`. The paused state is not returned as active processing, survives refresh and service restart, and can be recovered through `GET /api/status`.

Approve the current proposal:

`POST /api/runs/:name/correction/approve`

```json
{
  "decisionId": "current-verifier-decision-id"
}
```

Approval archives the current execution and verification reports as a distinct attempt, launches only the scoped corrective Executor, and then runs a fresh Verify. It does not rerun Plan, Explore, Consolidate, or Judge. Judge re-evaluation is bounded and occurs only if the corrective Executor reports a conflict with the approved plan.

Stop without applying the proposal:

`POST /api/runs/:name/correction/stop`

```json
{
  "decisionId": "current-verifier-decision-id"
}
```

Both endpoints compare the submitted decision ID with the persisted pending state after claiming admission. Duplicate, superseded, or already handled decisions return `409 stale_correction_decision`. Stopping records `stopped_by_user` and performs no further workspace changes.

## Optional explorers

`GET /api/status` includes `optionalExplorers` records for OpenClaw and Hermes Agent with `available`, `version`, and `enabled` fields. Both default to disabled.

`PUT /api/optional-explorers/:id` accepts `openclaw` or `hermes` and a JSON body such as `{ "enabled": true }`. Enabling requires an available binary. Roster changes are rejected while a workflow owns the admission slot and apply only to subsequently started or resumed runs. The service persists the allow-listed booleans atomically with user-only permissions; client-supplied commands or arguments are never accepted.

## Task attachments

`POST /api/attachments` accepts one raw file body. The client supplies an encoded original filename in `X-MoA-File-Name` and its media type in `Content-Type`. Supported document and image extensions are validated server-side. Files are limited to 20 MiB each, 10 per workflow, and 50 MiB total.

A successful `201` response returns an opaque attachment ID, normalized filename, media type, size, and SHA-256 hash. Pass selected IDs to `POST /api/run` as `attachmentIds`. MoA verifies every staged file again, creates a sealed batch, and imports it into the new run as `attachments.json` plus the private `attachments/` directory. The Plan stage receives these run-local paths and treats file contents as untrusted task context.

`DELETE /api/attachments/:id` removes an unused staged file. Unused staging records are private to the user and expire automatically.

## Resume a saved run

`POST /api/runs/:name/resume`

```json
{
  "instruction": "Add export support",
  "mode": "continue"
}
```

The endpoint validates the parent manifest, workspace, original objective, and inherited artifact hashes; enforces the one-active-workflow rule; compares the current repository against the best final Git evidence; calculates the next project revision; atomically creates a private linked run; and starts a fresh orchestration pass at Plan. Parent artifacts are referenced by run name, relative artifact name, SHA-256, and size. They are not modified or copied wholesale.

A successful `202` response includes:

```json
{
  "id": "active-workflow-id",
  "runName": "new-run-directory",
  "runId": "new-run-id",
  "parentRunId": "selected-run-id",
  "rootRunId": "first-project-run-id",
  "revision": 2,
  "workspace": "/absolute/project/path",
  "startingStage": "plan",
  "inheritedFrom": {},
  "drift": { "detected": false, "severity": "none" }
}
```

### Workspace drift

When HEAD, branch, tracked/untracked status, or bounded file hashes differ, the endpoint does not create a continuation and returns `409`:

```json
{
  "code": "workspace_drift",
  "requiresConfirmation": true,
  "drift": {
    "detected": true,
    "severity": "warning",
    "changedPaths": ["src/export.js"]
  }
}
```

After the user reviews that warning, submit the same request with `"confirmDrift": true`. A fresh pre-execution Git baseline is still captured before any writes.

### Errors

- `400`: invalid run name, instruction, mode, or workspace record
- `404`: parent run does not exist
- `409 active_run_conflict`: another workflow owns the single admission slot
- `409 workspace_drift`: explicit confirmation is required
- `410`: the recorded workspace was deleted
- `422`: manifest or inherited evidence is missing, corrupted, incompatible, or hash-mismatched

## Continuation persistence

New `run.json` files use schema version 2 and contain `runId`, `parentRunId`, `rootRunId`, `revision`, `resumedAt`, `resumeInstruction`, `inheritedFrom`, and continuation metadata. The run's own `events.jsonl` begins with `resume_requested`, `parent_context_loaded`, `workspace_drift_checked`, `continuation_created`, and `resume_started`.

Creation occurs in a private hidden staging directory and becomes visible through an atomic rename. Startup recovery removes only interrupted `.continuation-*.tmp` staging directories. Existing run directories are never used as staging areas.

Service-restart reconciliation of orphaned child processes is not part of this contract; watchdog recovery applies only while the owning service process remains alive.
