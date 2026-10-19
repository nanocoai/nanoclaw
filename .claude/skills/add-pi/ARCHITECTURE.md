# pi provider execution and setup

The provider targets NanoClaw's host contract seam version 1 and pins the pi
SDK at a fixed 1.3.x version. The skill owns its runtime, host, setup, and
gateway-credential adapters. Core supplies the provider contracts, delivery
wording, the memory renderer, resolved MCP configuration, and container policy.

## Turn completion

pi's SDK emits a callback stream of session events; its `prompt()` promise spans
auto-retries, in-place compaction, and follow-ups queued mid-run. Completion is
authoritative only when both the promise settles and `agent_settled` fires, so
the provider waits for both instead of guessing from a single event.

Every underlying SDK event yields at least one `activity` ProviderEvent, keeping
the poll-loop's heartbeat honest through long tool runs. A trailing error-stop
assistant message after the final settlement is a fatal run failure; a recovered
later turn wins. The result event carries the last assistant text of the batch,
which covers mid-turn `push()` follow-ups.

A resumed session whose first turn produced no assistant work and surfaced no
error is treated as a dead continuation: one fresh-session fallback per query,
with the original prompt replayed and a second `init` persisted. A turn that
errored propagates its error rather than replaying.

## Memory

Before a new pi session opens, the provider runs the registered shared memory
session hook and prefixes its output, plus the runner's instructions, onto the
opening prompt as one `<system>` block. Resumed sessions are not re-injected.
The hook is fail-closed: unregistered, undeclared-source, non-zero exit, timeout,
or empty output each log one line and skip injection rather than failing the
turn. pi compacts in place, so no post-compaction re-arm exists.

The shared `memory/` tree is the same one every provider uses, so switching a
group between providers keeps its memory.

## MCP

pi does ship a native MCP path (an extension built from an agentDir `mcp.json`)
and this bridge is kept instead, for semantics that extension does not provide:
deterministic collision-checked tool names matching the Claude convention,
JSON-Schema `pattern` stripping (some model APIs reject the regex dialects MCP
servers ship), `isError` results thrown rather than silently resolved,
per-turn `abort()` that cancels in-flight calls without closing servers, and
lazy reconnect of a single dead server.
maps the core's `McpServerConfig` to pi `ToolDefinition[]`: stdio (native `cwd`
support — no shim) and Streamable HTTP only (no legacy SSE fallback). A server
that fails to connect or list is skipped with a log line; an unhealthy server
reconnects lazily once; `abort()` cancels in-flight `callTool` requests but never
closes servers. Errors must throw, because pi marks error tool results from
exceptions only.

## Credentials and installation

pi owns no login. Every credential goes through the selected gateway: the
provider writes fixed `gateway-managed` placeholders into the group's agentDir
before each session open, and the gateway replaces them on the wire by
destination host. ChatGPT subscription auth is pi's `openai-codex` provider,
which reuses the gateway's Codex/ChatGPT login; because pi decodes the access
token to read the account id, the placeholder is a syntactically valid JWT
carrying the placeholder claim. API-key providers get a placeholder `api_key`
entry, and the gateway injects the real key by host. Setup stores keys through
`getCredentialStore().connection(target)` and records the provider ids in
`PI_GATEWAY_PROVIDERS`; the provider contains no gateway client and no
fallback when the selected gateway fails.

A real login already present in the group's agentDir is never overwritten: the
initializer only fills absent entries, atomically, without following a planted
symlink.

Fresh installation copies the payload, appends five barrel imports, installs the
pinned SDK in the runner package, and rebuilds the local image. The exact seam
version predicate guards every mutation. Removal derives destinations from the
skill declarations and reverses every registration and dependency change.

## Verification boundaries

Unit and integration tests cover barrel registration, contract conformance, the
MCP bridge over an in-memory transport, turn/push behavior, empty-resume
fallback, and the gateway-auth placeholder writer. They prove adapter behavior,
not live account entitlement, gateway refresh behavior, or external model
quality.
