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

Before each external turn, the runner renders memory through the registered
shared hook and atomically writes it with current core instructions and delivery
wording to one file under writable XDG data. The write happens under the existing
turn lock. The file is listed in native `instructions` next to the group's
`CLAUDE.md` and `CLAUDE.local.md`.

OpenCode 1.18.25 rereads those files on each model step, including native
continuation after compaction. Task children use the same global configuration
and inherit the current turn's file. No plugin, native memory hooks, parent walk,
or per-session snapshot store is needed.

Memory rendering runs once per external turn, including a resumed session.
A compaction in the middle of a turn uses that turn's starting memory snapshot;
the next external turn refreshes it. This freshness tradeoff is intentional.
A renderer failure logs the problem and keeps current core instructions and
routing, without retaining a previous turn's stale memory.

## Offline startup

The container supplies generated configuration and disables `.opencode` project
configuration with `OPENCODE_DISABLE_PROJECT_CONFIG`. It declares no plugin and
uses normal writable native config locations; there is no managed config tree,
XDG override, or config symlink. Host-native configuration remains separate.

Pinned OpenCode may attempt its own background authoring-dependency install in
a writable config directory. With no declared plugin, server startup does not
wait for it. Offline native tests establish that model turns, compaction and
Task children work without a package-registry response. Existing containers must
be recreated after refresh to discard config symlinks from the earlier payload.

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

The lightweight authentication check uses the skill planner to detect missing
copy, append, dependency, or CLI declarations. Since install mode deliberately
preserves existing files and packages, it separately compares exact dependency
pins and CLI fields against the same parsed skill declarations. It does not
maintain another payload inventory or run subprocesses. Existing install/refresh
contract verification imports and tests the real barrels; the build step owns
image freshness. Model selection does not repeat installation checks. Declaration
completeness is not proof that edited source, an image, or an account works.

## Verification boundaries

Unit and socket tests cover event lifetime, failure reconciliation, cancellation,
memory inheritance, vault metadata, credential rotation, and installation declaration
checks. The optional native test in
`payload/container/agent-runner/src/providers/opencode.native.test.ts` exercises the
actual pinned executable and SDK against a local model and MCP server, including
a 65-second tool call. These fixtures prove adapter behavior without establishing
live account entitlement, OAuth refresh reliability, or external model quality.
