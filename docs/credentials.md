# Credential abstraction

NanoClaw's host has two modes for provider credentials, selected per
agent group / runtime provider / model provider / model / auth mode by
the credential resolver (`src/credentials/`).

## Two modes

1. Gateway-injected (`refreshPolicy: "gateway"`) — preferred.
   The container sees only a placeholder token and the gateway base URL.
   OneCLI (or any future credential proxy) rewrites the Authorization
   header on the wire. Applies to all API-key, bearer, and most OAuth
   credentials. Anthropic API keys, OpenAI keys, OpenRouter keys,
   Gemini keys, custom endpoints — all gateway-injected.

2. Native auth bundle (`refreshPolicy: "runtime"`) — compatibility
   mode for subscription CLIs that own their own auth state file. Today
   this covers Codex (`~/.codex/auth.json`); future: Pi
   (`~/.pi/agent/auth.json`), possibly Cursor / OpenCode. The host
   materializes the bundle into a per-session directory and mounts it
   into the container. The vendor runtime refreshes its own state
   through the mount.

## Refresh ownership

- `refreshPolicy: "gateway"` — OneCLI / gateway refreshes and injects.
  Container never holds a real secret.
- `refreshPolicy: "runtime"` — vendor runtime refreshes its local file.
  When OneCLI bundle storage exists, `syncBack: true` will reseal the
  refreshed bundle into encrypted storage.

## The resolver hook

`src/credentials/resolver.ts` exposes a process-global hook that
installs (course / classroom / multi-tenant skills) can register to
override credential decisions per agent group:

```ts
type CredentialResolverHook = (input: {
  agentGroupId: string;
  runtimeProvider: string;
  modelProvider?: string;
  modelId?: string;
  authMode?: 'auto' | 'api_key' | 'subscription' | 'oauth' | 'native';
  targetHost?: string;
  targetPath?: string;
  operation?: string;
}) => Promise<CredentialDecision>;

setCredentialResolverHook(fn): void;
resolveCredential(input): Promise<CredentialDecision>;
```

Trunk's default hook returns `{ kind: 'fallback' }` — same behaviour
as before this abstraction landed. Multi-tenant / classroom / per-user
installs register a real resolver.

**Hooks must be idempotent and side-effect-free.** The resolver fires
exactly once per container spawn for the active provider — but it is
called from `buildContributionForSpawn`, which a future credential
proxy could also invoke per-request. A stateful hook (rate-limited
token mint, one-shot provisioner) is not currently supported.

## Decision kinds

| Kind | When | Effect |
|------|------|--------|
| `gateway_secret` | API-key / bearer / OAuth provider with placeholder injection | Env carries baseUrl + placeholder; OneCLI rewrites Authorization on wire |
| `native_auth_bundle` | Codex subscription, future Pi subscription | Bundle materialized + mounted; runtime owns refresh |
| `connect_required` | User/agent group needs to connect a provider account | 402 envelope from gateway; spawn refusal from container-runner |
| `forbidden` | Policy denies this combination | 403 envelope; spawn refusal |
| `fallback` | No override — use existing path | Provider config fn / .env / OneCLI default routing |

Env wiring for `gateway_secret` is keyed by `providerId`:

| providerId | base URL env var | token env var |
|------------|-----------------|---------------|
| anthropic | `ANTHROPIC_BASE_URL` | `ANTHROPIC_AUTH_TOKEN` |
| openai | `OPENAI_BASE_URL` | `OPENAI_API_KEY` |
| openrouter | `OPENROUTER_BASE_URL` | `OPENROUTER_API_KEY` |
| google | `GOOGLE_BASE_URL` | `GOOGLE_API_KEY` |

Other `providerId` values pass through silently — the provider's
registered container config fn is responsible for SDK env wiring.

## Internal headers

Containers and credential proxies use these to attribute requests:

- `x-nanoclaw-agent-group`
- `x-nanoclaw-runtime-provider`
- `x-nanoclaw-model-provider`
- `x-nanoclaw-model`

`stripNanoclawHeaders()` removes them before forwarding upstream.
Internal hints must not leak to vendor APIs.

## Provider routes

`src/credentials/provider-routes.ts` is a registry mapping logical
provider ids (`openai`, `anthropic`, `openrouter`, `google`, `local`)
to upstream base URLs. Used by future credential proxies that route
by path prefix (matching the gccourse pattern). OneCLI today routes
by per-secret host patterns; the registry exists for installs that
swap in a path-prefix proxy.

## Spawn refusal

When the resolver returns `connect_required` or `forbidden`,
container-runner logs the refusal and skips spawning. The user's
inbound message remains pending until the policy changes — the
host does not currently surface the refusal back to the user as a
chat message. Surfacing the refusal (with the connect URL for
`connect_required`) is captured as future work in this file.

## Codex status

- Codex subscription uses `native_auth_bundle` (host: scheme,
  `~/.codex/auth.json`).
- Codex API-key mode should use `gateway_secret` with
  `providerId: "openai"`. The container sees `OPENAI_BASE_URL` pointed
  at the gateway and `OPENAI_API_KEY=placeholder`; the real key never
  enters the container.

The trunk credential abstraction is the prerequisite. The Codex
provider refactor itself lives on the `providers` branch and is
applied via the `/add-codex` skill.

## Future work

- OneCLI-managed encrypted native bundles (`onecli:` bundleRef scheme).
- Sync-back for refreshed bundles.
- Concurrency protection on bundle materialization.
- Pi provider, OpenCode credential alignment, Cursor compatibility.
- Surfacing `connect_required` and `forbidden` refusals back to the
  user via the session's outbound DB (currently silent).
- Documenting and enforcing the "hooks must be idempotent" contract
  via runtime assertions in dev mode.

## Reference design

Inspired by `chiptoe-svg/nanoclaw_gccourse`, branch
`classroom-x7-provider-auth`, file `src/credential-proxy.ts`. The
gccourse fork ships a path-prefix credential proxy with a
`studentCredsHook` resolver. Upstream NanoClaw keeps OneCLI as the
gateway implementation and exposes the same hook pattern for installs
that need per-agent-group credential decisions.
