# OpenCode provider execution

The provider targets NanoClaw's host contract seam version 1 and pins the native
OpenCode CLI and SDK together at 1.18.25. The skill owns its runtime, host, and authentication adapters. The core supplies provider contracts, delivery
wording, the memory renderer, resolved MCP configuration, and container policy.

## Turn completion

OpenCode events describe activity and can include stale idle events or recoverable
errors during compaction. HTTP disconnects can also leave native execution alive.
Using event order as completion authority caused missed replies and unsafe replay.

Each shared runtime therefore serializes prompts and continuously reads its event
stream before starting a turn. The synchronous native prompt response determines
completion. A client-assigned user message ID and durable session history identify
the turn's assistant messages, including native compaction continuation. All
deliverable text parts are retained; internal summaries are excluded. Missing
history or uncertain execution fails visibly without submitting the prompt again.
An abort must settle the original native prompt within a bounded cleanup window;
otherwise the provider stops its owned server before permitting another turn.

Completed native errors retain earlier verified text and return one failed
result, so the core completes the exchange once. Native OpenCode owns retry
counts; each history page has its own bounded request.
Raw API diagnostics stay in the error event for logs and never enter result
text, where response-body markup could be mistaken for a deliverable. The core
sends a fixed failure notice, including after a partial reply.

This uses the existing SDK and persistence. A new retry queue, parallel native
prompts, and idle-event completion would add ambiguous execution ownership.

## Memory and native continuation

Injecting memory into the next external prompt misses OpenCode's automatic
continuation after compaction. Native event handlers are not awaited, so refreshing
memory from a compaction event would race the next model request.

A local native plugin uses the awaited system-transform and session-compacting
hooks. The provider seeds rendered memory once on a fresh session and updates
current core instructions and delivery wording before every external turn. The
plugin supplies that context on each native model request and refreshes rendered
memory before compaction continues. Private per-session snapshots preserve it
across server restarts. Children resolve only their actual ancestor's snapshot;
child compaction writes a separate snapshot. Renderer failures retain the last
snapshot; successful empty output clears it. Legacy sessions without a snapshot
receive current core instructions until their next compaction refreshes memory.

Native system-transform input has a session ID and model, but no invocation
purpose. The same session-scoped context can therefore reach native title and
compaction helpers. Task-child inheritance is intentional; unrelated sessions
cannot read another session's snapshot. Purpose-specific filtering would need
an upstream hook that exposes that distinction rather than guessing from prompt
text.

## Offline startup

Container configuration lives in the existing read-only source mount. Before
server startup, the provider links only the normal XDG config home's `opencode`
child to that bundled directory. The XDG parent remains writable and retains its
normal location for shell tools, MCP servers, memory hooks and native helpers.
An existing matching symlink is reused; any other existing `opencode` path stops
startup with a preservation instruction. No existing configuration is replaced.
The host only persists OpenCode's separate XDG data directory; the config link
is private to the running container and is recreated after replacement.

OpenCode follows the link and skips its plugin-authoring dependency installation
because the target is read-only. The shipped memory plugin uses only local
modules. The container disables `.opencode` project overrides and gets model,
permission, and MCP configuration from core. Host-native configuration is separate.
This avoids adding a package dependency, child-process environment overrides, or
a new host mount contract. Native tests must mount runner source read-only to
exercise the same offline behavior; a writable checkout allows OpenCode to
install its authoring dependencies into the bundled config tree.

## Credentials and installation

Authentication uses this NanoClaw installation's OneCLI management URL, API key,
and optional project ID. Secret metadata is checked before prompting for a key.
Rotation updates the same secret ID to preserve grants. Moving an API key to a
different exact host requires explicit confirmation; the existing value may be
kept or replaced. The original metadata is rechecked before writing. Ambiguous names, wildcard hosts, inherited
secrets, and incompatible credential types stop the flow. Supported API-key providers declare their
actual header scheme, including Google's `x-goog-api-key`. Unknown schemes require
an explicit adapter rather than guessing a bearer header. Local keyless endpoints
need no vault access. Provider defaults are saved only after authentication succeeds.
Exported setting conflicts are checked before credential prompts or keyed model
discovery. If a custom endpoint's model is exported, setup offers current/manual
model selection before credential work. Metadata failures identify mismatched
field names without exposing their values.

Apply the skill, verify its contracts, and build the local image before running
the direct authentication or model command. Authentication leaves installed files
and the image alone. Reapplying the skill in refresh mode replaces its payloads
and pins; back up local payload edits first. An exact seam-version predicate
guards every skill mutation during installation and refresh. Removal lists every
installed file and registration.

The authentication and model commands also require the configured image to be
available locally. Their offline preflight imports the current mounted runtime
and SDK inside that image, checks runtime registration, and verifies CLI/SDK
1.18.25. It uses read-only source and image files with disposable temporary home
state; it never pulls packages or images, rebuilds, or accesses account credentials.
This proves that the installed modules and executable load, not that a backend,
OneCLI grant, or account login works.

## Verification boundaries

Unit and socket tests cover event lifetime, failure reconciliation, cancellation,
memory inheritance, vault metadata, credential rotation, and installed runtime
preflight. The optional native test in
`payload/container/agent-runner/src/providers/opencode.native.test.ts` exercises the
actual pinned executable and SDK against a local model and MCP server, including
a 65-second tool call. These fixtures prove adapter behavior without establishing
live account entitlement, OAuth refresh reliability, or external model quality.
