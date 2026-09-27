# OpenCode provider execution and setup

The provider targets NanoClaw's host contract seam version 1 and pins the native
OpenCode CLI and SDK together at 1.18.25. The skill owns its runtime, host, setup,
and authentication adapters. The core supplies provider contracts, delivery
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
managed `XDG_CONFIG_HOME` override, or config symlink. The host still supplies
per-session `XDG_DATA_HOME` for persisted native state and the rendered memory
file. Host-native configuration remains separate.

Pinned OpenCode may attempt its own background authoring-dependency install in
a writable config directory. With no declared plugin, server startup does not
wait for it. Offline native tests establish that model turns, compaction and
Task children work without a package-registry response. Existing containers must
be recreated after refresh to discard config symlinks from the earlier payload.

## MCP timing

MCP calls allow 330 seconds, covering the core's five-minute human question
window plus transport overhead. Cancelling a turn cancels its active tool wait;
a question already posted to chat remains visible.

## Credentials and installation

OpenCode owns login, model selection, endpoint names, and API header schemes.
Every credential goes through `getCredentialStore().connection(target)`: the
provider describes the destination, the header scheme, its runtime placeholder,
and for ChatGPT the named `chatgpt` OAuth profile with OpenCode's public client;
the selected gateway owns native storage, ids, grants, refresh, and endpoint
constraints. The provider contains no gateway client, no gateway-name dispatch,
and no fallback when the selected gateway fails. `scripts/opencode-gateway.test.ts`
drives the real setup flow through a fixture gateway that exists nowhere else.

The gateway reports whether a stored credential exists and whether it can be
kept; OpenCode never sees a native id. A blank key keeps a reusable entry;
a non-reusable one (an expired Iron broker, a moved Iron key) demands a value.
Moving a key to another exact host requires explicit confirmation inside the
gateway's lookup. OneCLI can keep its stored value across a move; Iron requires
re-entry because its update API replaces the source alongside the rules.
Ambiguous or incompatible entries fail without exposing their values, and both
gateways refuse a write when the entry changed since the lookup.

Iron uses install-scoped native foreign IDs. ChatGPT creates a broker with
OpenCode's pinned public OAuth client, a broker-backed bearer secret, and a
separate account-header secret. Reauthentication preserves all three IDs.
Missing grants are reconciled without extracting values. Broker refresh activity
may continue during login; changes to its client binding or secret rules stop
setup. Partial saves can be retried using those same owned IDs. The native login
file is removed before network waits and on failure; agents receive only fixed
placeholders. Existing OneCLI credential names and formats remain compatible.

Gateway endpoint validation happens before key prompts or catalog requests.
Iron requires HTTPS on port 443 and DNS names; this includes keyless endpoints.
The gateway permits the model destination only after prompts complete. Native
model domains and an operator-configured HTTPS model host are declared by the
OpenCode host contract on startup; explicit gateway policy holds remain in force.
Restart the host after changing backend settings. Defaults are saved only after
credentials and routing succeed. Exported setting conflicts are checked before
credential prompts or keyed discovery. Keeping a key never extracts it to list
models; the operator can enter a model ID manually.

Fresh setup applies the skill, verifies contracts, builds the local image, and
then authenticates through a lazily loaded setup adapter. Normal re-authentication
of an installed provider leaves its files and image alone. Explicit `--refresh`
replaces skill-owned payloads and pins before verification/build/auth; local
payload edits must be backed up first.
An exact seam-version predicate guards all skill mutations during installation
and refresh. The install flow skips build, test, and external skill effects because
its caller owns those steps. Missing or mismatched host Bun uses the container's
pinned version through pnpm. Removal derives copied-file destinations from the
skill declarations and reverses every registration and dependency change.

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
memory inheritance, vault metadata, credential rotation, setup failure ordering,
unsupported-core refusal, installation refresh, and declaration checks. The optional native test in
`payload/container/agent-runner/src/providers/opencode.native.test.ts` exercises the
actual pinned executable and SDK against a local model and MCP server, including
a 65-second tool call. These fixtures prove adapter behavior without establishing
live account entitlement, OAuth refresh reliability, or external model quality.
