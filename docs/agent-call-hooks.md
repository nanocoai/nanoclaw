# Deterministic Agent Call Hooks

## Summary

Add a deterministic hook layer around NanoClaw agent invocations so owners can run predictable procedures immediately **before** and **after** an agent call. Hooks are configured declaratively, execute with explicit inputs and outputs, and can gate, mutate, annotate, retry, or reject a call without relying on model behavior.

In NanoClaw's v2 architecture, the first implementation seam should live in the container agent-runner: after the runner reads pending inbound messages from `inbound.db` and before it calls the configured provider, then again after provider completion and before the runner writes deliverable output to `outbound.db`. Host-side delivery guards remain responsible for privileged delivery actions; hooks are a deterministic shaping and validation layer around the agent call itself.

## Goals

- Provide deterministic pre-call and post-call procedures for agent runs.
- Support policy enforcement, prompt/context shaping, validation, logging, redaction, routing hints, and output normalization.
- Make hook execution auditable, reproducible, timeout-bounded, and easy to debug.
- Keep hook behavior separate from model instructions, skills, memories, and provider implementations.
- Allow hooks at multiple scopes: system, agent group, named agent/provider, scheduled task, and one-off call.

## Non-goals

- Replace model instructions, skills, MCP tools, or host delivery guards.
- Provide arbitrary long-running workflows inside hooks.
- Let hooks silently bypass access controls, approval checks, or privileged-action guards.
- Make hook results probabilistic or model-generated.
- Move all host-side policy into the agent container.

## Terminology

- **Agent call**: one invocation of an agent provider from the agent-runner for a pending message, task, or wake event.
- **Pre-call hook**: deterministic procedure run before the provider receives constructed context.
- **Post-call hook**: deterministic procedure run after the provider returns and before final response persistence or delivery.
- **Hook chain**: ordered list of hooks that run for a phase.
- **Hook result**: structured output describing whether to continue, block, mutate, annotate, retry, or require review.
- **Mutation patch**: constrained change set applied by NanoClaw, not arbitrary object replacement by the hook process.

## Hook Phases

### `before_agent_call`

Runs after pending inbound work is accepted by the container runner but before provider context construction is finalized.

Typical uses:

- Validate source message, destination, task state, rate limits, or required metadata.
- Redact secrets or sensitive fields before they enter model context.
- Inject deterministic context, environment facts, or compliance banners.
- Rewrite or normalize the requested task.
- Select provider/runtime options within configured policy.
- Narrow tool/runtime permissions for the call.
- Block calls that violate deterministic policy.

### `after_agent_call`

Runs after the provider response/tool outcome is produced but before the runner writes the final response to `outbound.db`.

Typical uses:

- Validate output format or required report fields.
- Redact sensitive output.
- Add deterministic footers, labels, or metadata.
- Normalize output envelopes for destination adapters.
- Trigger bounded local follow-up effects, such as task log append metadata.
- Mark output as blocked, retryable, or human-review-required.

## Initial Integration Points

The v1 implementation should wire hooks into `container/agent-runner/src/`, not the host router, because hooks surround the provider call and need access to the fully assembled agent-call input and raw provider result.

Recommended flow:

1. Agent-runner reads pending messages from `inbound.db`.
2. Runner resolves destinations, provider config, tools, instructions, memory, and task metadata as it does today.
3. Runner resolves the `before_agent_call` hook chain.
4. Runner executes pre-call hooks and applies approved mutation patches.
5. If not blocked or held, runner calls the provider.
6. Runner resolves the `after_agent_call` hook chain.
7. Runner executes post-call hooks and applies approved mutation patches.
8. Runner persists final output, blocked status, retry request, or review request through existing outbound/session-state mechanisms.

Host-side router and delivery code can later gain companion hooks if a separate `before_route`, `before_delivery`, or `after_delivery` phase is needed. Those phases are out of scope for this spec.

## Hook Scopes and Precedence

Hooks are merged into one chain per phase in this order:

1. `system` hooks: platform-wide invariants baked into NanoClaw.
2. `group` hooks: configured on the agent group/container config.
3. `agent` hooks: configured for a named assistant/provider persona.
4. `task` hooks: configured on a scheduled task definition.
5. `call` hooks: supplied for a single explicit call, if permitted.

Within each scope, hooks run by ascending `priority`, then stable `id` order.

Higher scopes may mark hooks as `required: true`; lower scopes cannot disable, reorder, or override required hooks. Lower scopes may add additional restrictions or validation.

## Configuration Shape

A minimal group-level configuration can live in `container_configs` and be materialized into the per-group `container.json` alongside provider/model/packages/MCP settings.

Example:

```yaml
agent_hooks:
  before_agent_call:
    - id: require-owner-or-orchestrator
      priority: 100
      runtime: builtin
      procedure: caller_allowlist
      required: true
      config:
        allowed_from:
          - owner
          - orchestrator
      on_error: block

    - id: redact-known-secrets
      priority: 200
      runtime: builtin
      procedure: regex_redact
      config:
        patterns:
          - name: token-like-value
            regex: "(?i)(api[_-]?key|token|secret)=\\S+"
      on_error: block

  after_agent_call:
    - id: require-completion-report
      priority: 100
      runtime: builtin
      procedure: schema_validate
      config:
        required_fields:
          - outcome
          - verification_results
          - blockers
      on_error: require_human_review
```

Command hook example:

```yaml
agent_hooks:
  before_agent_call:
    - id: inject-business-hours
      priority: 300
      runtime: command
      command:
        - python3
        - /workspace/agent/hooks/business_hours.py
      timeout_ms: 500
      permissions:
        network: false
        filesystem: read_only
      on_error: block
```

## Hook Input Contract

Each hook receives a JSON object on stdin for command hooks or as an internal argument for builtins:

```json
{
  "schema_version": "agent-hook.v1",
  "phase": "before_agent_call",
  "hook": {
    "id": "inject-business-hours",
    "scope": "group",
    "version": "sha256:..."
  },
  "call": {
    "id": "call_123",
    "session_id": "session_123",
    "agent_group_id": "ag_123",
    "agent_name": "copilot",
    "destination": "orchestrator",
    "trigger": "message",
    "created_at": "2026-07-31T05:00:00Z"
  },
  "actor": {
    "kind": "user",
    "id": "discord:sorenfive",
    "display_name": "sorenfive"
  },
  "request": {
    "messages": [],
    "prompt": "...",
    "attachments": [],
    "metadata": {}
  },
  "runtime": {
    "provider": "codex",
    "model": "...",
    "tools": [],
    "permissions": {},
    "timezone": "Asia/Makassar"
  },
  "response": null,
  "state": {
    "annotations": {},
    "previous_hook_results": []
  }
}
```

For `after_agent_call`, `response` is populated:

```json
{
  "response": {
    "messages": [],
    "files": [],
    "tool_calls": [],
    "status": "complete",
    "usage": {}
  }
}
```

The runner should omit unavailable fields rather than fabricate them. Hooks must tolerate missing optional fields.

## Hook Output Contract

Each hook emits JSON:

```json
{
  "schema_version": "agent-hook-result.v1",
  "status": "continue",
  "reason": "short deterministic explanation",
  "mutations": {
    "request": {},
    "runtime": {},
    "response": {},
    "metadata": {}
  },
  "annotations": {
    "key": "value"
  },
  "audit": {
    "summary": "what the hook checked or changed",
    "redactions": []
  }
}
```

Valid statuses:

- `continue`: proceed without mutation.
- `noop`: proceed and record that no condition matched.
- `mutate`: apply declared mutation patches, then proceed.
- `block`: stop the call or delivery and record a blocked result.
- `retry`: only valid in `after_agent_call`; must include bounded retry instructions.
- `require_human_review`: pause final delivery and create a review/approval item.

## Mutation Rules

Allowed pre-call mutations:

- Add, remove, or update request metadata.
- Append deterministic context messages under a distinct source label.
- Redact or replace message content.
- Narrow, but not broaden, permissions.
- Select among pre-approved providers, models, or runtime options.
- Attach deterministic files or facts available to the hook.

Allowed post-call mutations:

- Redact response text or files.
- Add deterministic labels, summaries, or metadata.
- Normalize output into a required response envelope.
- Convert a response to blocked or review-required.

Forbidden mutations:

- Escalate permissions beyond configured maximums.
- Forge actor identity, timestamps, approval state, or audit logs.
- Delete immutable audit records.
- Execute unbounded retries.
- Mutate required higher-scope hook outputs.
- Write directly to `inbound.db` or `outbound.db`; all persistence goes through runner-owned APIs.

## Runtime Types

### `builtin`

Platform-provided deterministic procedures, versioned and tested by NanoClaw.

Initial candidates:

- `caller_allowlist`
- `schema_validate`
- `regex_redact`
- `jsonpath_assert`
- `business_hours_gate`
- `destination_route_hint`

### `command`

Runs a local executable with JSON stdin/stdout.

Constraints:

- Default no network.
- Default read-only filesystem.
- Timeout required; default max 2 seconds.
- Output size cap required; default 64 KB.
- Non-zero exit is handled according to `on_error`.
- Command path should be absolute or resolved under an approved workspace directory.

### Future: `wasm` or constrained JavaScript

A portable sandbox runtime can be added later. V1 should ship with `builtin` and `command` only to keep the surface small.

## Error Handling

Each hook declares `on_error`:

- `block`: safest default for required policy hooks.
- `continue`: permitted only for non-required enrichment hooks.
- `require_human_review`: pause and request review.
- `skip`: record failure and skip downstream mutation from that hook.

Hook errors include timeout, invalid JSON, schema violation, excessive output, denied permission, unsupported mutation, or runtime crash.

## Audit and Observability

Every hook execution should record:

- Hook id, scope, version/hash, phase, and priority.
- Input digest, not necessarily full sensitive input.
- Output status and mutation summary.
- Duration, exit code, timeout flag, and error details.
- Final effective hook chain for the call.

Audit records should be append-only and inspectable through CLI/API, for example:

```bash
ncl sessions get <session-id> --hooks
ncl hook-runs list --session-id <session-id>
ncl hook-runs get <hook-run-id>
```

If a dedicated central table is too much for v1, the runner can start by writing structured hook-run events into session state or existing logs, then promote them to first-class records later.

## Security Model

- Hooks run under least privilege.
- Required hooks can only be changed by principals authorized for their scope.
- Command hooks must be pinned by path and should optionally be pinned by content hash.
- External network is disabled unless explicitly granted and approved.
- Secrets are never passed to hooks unless a hook declares exact secret access and policy allows it.
- Hook output is schema-validated before application.
- Mutations are applied through a safe patcher, not arbitrary object replacement.
- Hooks cannot directly approve or execute privileged host actions; those still flow through existing guard and approval machinery.

## Determinism Requirements

A hook is considered deterministic if, for identical input plus declared external resources, it returns identical output.

To preserve this:

- Time must be supplied in the input; hooks should not call wall-clock time directly.
- Randomness is forbidden unless a seed is supplied in input.
- Network access is off by default and, when enabled, should be marked nondeterministic in audit.
- Files read by hooks should be content-digested in audit.
- Hook versions should be recorded using a content hash or builtin version.

## CLI/API Surface

Possible CLI additions:

```bash
ncl hooks list
ncl hooks validate ./hooks.yaml
ncl hooks test ./hooks.yaml --fixture fixture.json
ncl hook-runs list --session-id <session-id>
ncl hook-runs get <hook-run-id>
```

Possible group config command:

```bash
ncl groups config update --agent-hooks-file ./hooks.yaml
```

API concepts:

- `HookDefinition`
- `HookChain`
- `HookRun`
- `HookResult`
- `CallMutationPatch`

## Example Use Cases

### Enforce delegated-work report format

A post-call hook blocks completion reports that omit required fields such as outcome, files changed, verification run, commit hash, blockers, risks, and recommended next action.

### Redact secrets before model context

A pre-call hook applies deterministic secret patterns, replaces values with stable tokens, and records redaction counts.

### Business-hours task gate

A pre-call hook blocks or defers outbound user-facing task runs outside configured hours unless priority is `urgent`.

### Output approval gate

A post-call hook detects external publish/deploy intent and requires human review before delivery.

## Rollout Plan

1. Define TypeScript schemas for hook definitions, hook input, hook result, and mutation patches.
2. Implement hook chain resolver and stable ordering in the agent-runner.
3. Add builtin hook runtime and two builtins: `schema_validate` and `regex_redact`.
4. Add command hook runner with timeout, permission profile, stdout JSON parser, and audit logging.
5. Wire `before_agent_call` into provider context construction.
6. Wire `after_agent_call` into response persistence.
7. Add CLI validation and hook-run inspection.
8. Add tests for ordering, mutation safety, failures, required hooks, audit, and retries.
9. Enable behind a feature flag for one internal agent group.
10. Expand to task and per-agent scopes after group-scope validation.

## Acceptance Criteria

- Given a configured pre-call hook, NanoClaw executes it before provider context is finalized.
- Given a configured post-call hook, NanoClaw executes it before response persistence or delivery.
- Hook order is stable and matches documented scope and priority rules.
- Invalid hook output cannot mutate calls or responses.
- Required hook failures block or pause according to policy.
- Non-required enrichment hook failures can continue if configured.
- All hook runs are visible in audit logs with duration and result.
- Hooks can be tested against fixtures without invoking a provider.
- Pre-call hooks can redact or block input deterministically.
- Post-call hooks can validate and block malformed output deterministically.

## Open Questions

- Should one-off per-call hooks be allowed for ordinary users, or only admins and scheduled tasks?
- Should hooks be allowed to defer scheduled tasks directly, or only block with a reason?
- Should command hooks be stored in the repo, group workspace, central config, or a combination?
- Is a WASM runtime worth adding in v1 for stronger portability?
- What should the exact review UX be for `require_human_review` results?
- Should hook audit records live in session DBs, central DB, or both?
