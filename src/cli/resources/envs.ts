/**
 * Dev environments — the agent-facing claim surface (sandbox-spec D11, D12, D18).
 *
 * Rides the existing socket boundary and the group-scope whitelist; the
 * dev-env service does the work. Ownership is derived, never trusted: an
 * agent caller claims AS ITS GROUP, and touches only envs its group owns.
 * Because env ids are opaque (no group inside), the ownership rule lives
 * here rather than in the generic guard — and a foreign env id answers
 * exactly like a nonexistent one, so the surface is not an existence oracle
 * for other groups' environments.
 *
 * Commands are 'open' under D17 (permissive inside the sandbox); the
 * boundary confirms — pinned-env release first among them — arrive with
 * T7's permission posture, not here.
 *
 * Registered through registerResource (operations:{} + customOperations,
 * same shape as tasks/destinations) so every help surface — the `ncl help`
 * resources section, `ncl envs help`, and the unknown-command verb probe —
 * sees envs. Parsing stays lenient and in-handler: these verbs predate the
 * strict ColumnDef validator and their bespoke errors (duration units, JSON
 * options, owner derivation) must not change.
 */
import fs from 'node:fs';
import path from 'node:path';

import { DEV_TREE_OPTION as DEV_TREE_OPTION_KEY } from '../../dev-env/dev-tree.js';
import {
  HOST_OWNER_REF,
  getDevEnvService,
  getEnvExposureService,
  getStampRegistry,
  type DevEnvService,
  type EnvExposureService,
  type ExposureRow,
} from '../../dev-env/index.js';
import type { EnvSnapshot } from '../../dev-env/service.js';
import { isPathInside } from '../../inbox-safety.js';
import { sessionDir } from '../../session-manager.js';
import type { CallerContext } from '../frame.js';
import { registerResource } from '../crud.js';

function service(): DevEnvService {
  const svc = getDevEnvService();
  if (!svc) {
    throw new Error('dev-env is not enabled on this host — set NANOCLAW_DEV_ENV_DRIVER and restart the service.');
  }
  return svc;
}

/**
 * The C14 surface, when this install opted into one. Exposure is a hole in a
 * perimeter, so it ships off and the refusal names the switch rather than
 * pretending the verbs are missing.
 */
function exposureService(): EnvExposureService {
  const svc = getEnvExposureService();
  if (!svc) {
    throw new Error(
      'port exposure is not enabled on this host — set NANOCLAW_DEV_ENV_EXPOSURE_PROVIDER (v1: tailnet) ' +
        'and restart the service.',
    );
  }
  return svc;
}

/** Who signed the grant: derived from the caller, exactly like ownership. */
function authorFor(ctx: CallerContext): string {
  return ctx.caller === 'agent' ? ctx.agentGroupId : HOST_OWNER_REF;
}

function ownerFor(ctx: CallerContext, requested: string | undefined): string {
  if (ctx.caller === 'agent') {
    if (requested && requested !== ctx.agentGroupId) {
      throw new Error('agents claim as their own group — omit --owner');
    }
    return ctx.agentGroupId;
  }
  // The sentinel is a RESERVED group id (createAgentGroup refuses it): the
  // D19 claimant route derives its pod selector from ownerRef, and this name
  // must never select real pods.
  return requested ?? HOST_OWNER_REF;
}

/**
 * Fetch an env the caller may touch. A foreign env raises the SAME error as a
 * missing one — "not yours" must not confirm "exists".
 */
async function ownEnv(ctx: CallerContext, envId: string): Promise<EnvSnapshot> {
  const env = await service().status(envId);
  if (ctx.caller === 'agent' && env.ownerRef !== ctx.agentGroupId) {
    throw new Error(`no dev env ${envId}`);
  }
  return env;
}

function requireString(raw: Record<string, unknown>, key: string): string {
  const value = raw[key];
  if (typeof value !== 'string' || !value.trim()) throw new Error(`--${key} is required`);
  return value.trim();
}

const DURATION_UNITS: Record<string, number> = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/** '90s' | '15m' | '2h' | '1d' — the unit is required so a bare number never silently means the wrong scale. */
export function parseDurationMs(raw: unknown): number {
  const match = /^(\d+)(s|m|h|d)$/.exec(String(raw).trim());
  if (!match) throw new Error(`invalid duration "${String(raw)}" — use e.g. 90s, 15m, 2h, 1d`);
  return Number(match[1]) * DURATION_UNITS[match[2]];
}

/** The agent-facing dev-tree option: a path RELATIVE to the caller's session
 *  workspace (the /workspace mount itself — NOT the /workspace/agent group
 *  folder, which is a separate mount the session-dir arithmetic cannot reach). */
const DEV_TREE_OPTION = 'dev-tree';
/**
 * The driver-facing resolved form — minted HERE and nowhere else, and named
 * by the shared C16 vocabulary rather than by a third copy of the string.
 * dev-tree.ts is pure declaration, so importing it keeps the rule this file
 * lives by: the CLI never imports a driver.
 */
const DEV_TREE_RESOLVED_OPTION = DEV_TREE_OPTION_KEY;

/**
 * Resolve the dev-tree claim option host-side (the hot-loop flavor's one
 * security boundary): the agent names a path RELATIVE TO ITS OWN WORKSPACE
 * and the host derives the base from the caller's transport-authenticated
 * identity — `sessionDir(ctx.agentGroupId, ctx.sessionId)` is the exact host
 * directory the sandbox mounts at /workspace (container-runner mounts the
 * session folder there). An agent can therefore never name an arbitrary node
 * path: the reserved resolved key is refused on input, the relative path is
 * containment-checked lexically AND post-realpath (the workspace is
 * agent-writable, so a pre-placed symlink must not escape it), and the
 * result must be an existing directory.
 *
 * Host callers are refused in v1: a dev-tree source is defined as the
 * claiming sandbox's working tree, and a host caller has no code session to
 * derive one from.
 *
 * SCOPE: only the SESSION workspace resolves. /workspace/agent is a second
 * mount (the durable group folder, GROUPS_DIR/<folder> host-side) — it is
 * visible inside the sandbox under /workspace but is NOT under the session
 * dir host-side, so `sessionDir(...)/<rel>` arithmetic cannot reach it and a
 * checkout there must be cloned/copied into the session workspace first.
 * That limit is by decision (the ruling pins resolution to sessionDir), and
 * the not-found error below names it so the refusal reads as scope, not as
 * the host denying a directory the agent can plainly see.
 *
 * NOTE (substrate assumption, POC-true): the host runs natively ON the node,
 * so the host path this resolves IS the node path the driver's PV mounts. A
 * host-in-pod deployment needs a host→node path translation here.
 *
 * `baseDirFor` is injectable for tests only; production callers use the one
 * true sessionDir arithmetic.
 */
export function resolveDevTreeOption(
  ctx: CallerContext,
  options: Record<string, string> | undefined,
  baseDirFor: (agentGroupId: string, sessionId: string) => string = sessionDir,
): Record<string, string> | undefined {
  if (!options) return options;
  if (DEV_TREE_RESOLVED_OPTION in options) {
    throw new Error(
      `--options key "${DEV_TREE_RESOLVED_OPTION}" is reserved — pass {"${DEV_TREE_OPTION}": "<workspace-relative path>"} and the host resolves it`,
    );
  }
  const rel = options[DEV_TREE_OPTION];
  if (rel === undefined) return options;
  if (ctx.caller !== 'agent') {
    throw new Error(
      `${DEV_TREE_OPTION} claims are sandbox-only: the host derives the source tree from the claiming agent's own code session, which a host caller does not have`,
    );
  }
  if (!rel.trim())
    throw new Error(`${DEV_TREE_OPTION} needs a workspace-relative path, e.g. {"${DEV_TREE_OPTION}": "nanoclaw"}`);
  if (path.isAbsolute(rel)) {
    throw new Error(`${DEV_TREE_OPTION} takes a path relative to your /workspace — never an absolute path`);
  }
  const base = baseDirFor(ctx.agentGroupId, ctx.sessionId);
  const joined = path.resolve(base, rel);
  if (!isPathInside(base, joined)) {
    throw new Error(`${DEV_TREE_OPTION} must stay inside your workspace`);
  }
  let realBase: string;
  let real: string;
  try {
    realBase = fs.realpathSync(base);
    real = fs.realpathSync(joined);
  } catch {
    throw new Error(
      `${DEV_TREE_OPTION}: no such directory under this session's workspace: ${rel}` +
        ` (note: /workspace/agent is the durable group folder — a separate mount the host cannot` +
        ` resolve here; clone or copy the tree directly under /workspace first)`,
    );
  }
  // The workspace is agent-writable: a pre-placed symlink must resolve back
  // inside it or the claim is naming a tree the agent does not own (CWE-59).
  if (!isPathInside(realBase, real)) {
    throw new Error(`${DEV_TREE_OPTION} must stay inside your workspace`);
  }
  if (!fs.statSync(real).isDirectory()) {
    throw new Error(`${DEV_TREE_OPTION} must name a directory (your checkout), got a file: ${rel}`);
  }
  const { [DEV_TREE_OPTION]: _dropped, ...rest } = options;
  return { ...rest, [DEV_TREE_RESOLVED_OPTION]: real };
}

/**
 * `--dev <path>` — first-class sugar for the reserved dev-tree option (C16):
 * one resolution path, unchanged, so the flag can never grow semantics the
 * option form lacks. Works against any stamp that declares a dev block; the
 * driver refuses the rest at claim, naming the missing declaration.
 */
function withDevSugar(
  raw: Record<string, unknown>,
  options: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (raw.dev === undefined) return options;
  const dev = String(raw.dev).trim();
  if (!dev) throw new Error('--dev needs a path relative to your /workspace, e.g. --dev my-checkout');
  if (options && DEV_TREE_OPTION in options) {
    throw new Error(`--dev and --options {"${DEV_TREE_OPTION}": …} name the same tree — pass one`);
  }
  return { ...options, [DEV_TREE_OPTION]: dev };
}

function parseOptions(raw: unknown): Record<string, string> | undefined {
  if (raw === undefined) return undefined;
  // Inline JSON text on argv, or an already-parsed object when the caller
  // shipped it via --stdin-json (the merge hands structured values through
  // as-is) — same structural checks either way, same as stamps' config/source.
  let parsed: unknown = raw;
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new Error('--options must be a JSON object of string values (inline or via --stdin-json)', {
        cause: error,
      });
    }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('--options must be a JSON object of string values (inline or via --stdin-json)');
  }
  const options: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value !== 'string') throw new Error(`--options value for "${key}" must be a string`);
    options[key] = value;
  }
  return options;
}

/**
 * The C15 provenance leg of `envs get`: env → stamp@version → digest →
 * registry ref, in words — "where did these bits come from" is the question
 * the chain exists to answer and a bare digest does not answer it. Chains
 * through the VERSION THE CLAIM RECORDED, so it still answers after a later
 * update bumps the stamp (rows are kept forever). Null when there is nothing
 * to chain: code-provided stamps, node-local origins, a dormant registry.
 */
async function imageProvenanceFor(env: EnvSnapshot): Promise<string | null> {
  if (env.stampVersion === null) return null;
  const reg = getStampRegistry();
  if (!reg) return null;
  const image = await reg.images.get(env.stampId, env.stampVersion);
  if (!image) return null;
  return `pulled from ${image.sourceRef}`;
}

/**
 * A port number from argv (text) or from `--stdin-json` (already a number) —
 * the same both-forms rule `--options` and stamps' `--config` follow.
 */
function requirePort(raw: Record<string, unknown>): number {
  const value = raw.port;
  const port = typeof value === 'number' ? value : Number(String(value ?? '').trim());
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error('--port is required and must be a TCP port number (1-65535)');
  }
  return port;
}

/** One live grant, in the shape the ledger keeps it — name, target, provider, URL. */
function renderExposure(row: ExposureRow): string {
  return [
    `${row.name}  ${row.state}  ${row.url}`,
    `  target: env ${row.envId} → ${row.service}:${row.port}  provider=${row.provider}  approved-by=${row.approvedBy}`,
    row.state === 'revoked' && `  revoked: ${row.revokeCause ?? 'unknown'} at ${row.revokedAt ?? '?'}`,
    // The allocation residual, said where a human reads it: under the tailnet
    // provider the URL carries a reusable port, not the name, so an old
    // bookmark can eventually mean a different env.
    row.state !== 'revoked' &&
      '  lifetime: this URL means this exposure until it is revoked — after that it may be reissued',
  ]
    .filter(Boolean)
    .join('\n');
}

function renderEnv(env: EnvSnapshot & { exposures?: ExposureRow[] }): string {
  const lifetime =
    env.lifetime.mode === 'ttl' ? `ttl until ${new Date(env.lifetime.expiresAtMs).toISOString()}` : env.lifetime.mode;
  const endpoints = Object.entries(env.endpoints)
    .map(([name, addr]) => `${name}=${addr}`)
    .join(' ');
  const access = Object.entries(env.access)
    .map(([name, path]) => `${name}=${path}`)
    .join(' ');
  // The short failure marker rides the status line, so a failed row says WHY
  // even in the one-line scan of `envs list` (#20). Rows failed before the
  // reason column existed carry null and render the bare state, honestly.
  const failMark = env.state === 'failed' && env.failureKind ? ` (${env.failureKind})` : '';
  return [
    // stamp@version when a registered definition realized the claim; bare
    // stamp id for code-provided stamps (the registry never shadows those).
    `${env.envId}  ${env.state}${failMark}  stamp=${env.stampId}${env.stampVersion === null ? '' : `@v${env.stampVersion}`}  owner=${env.ownerRef}  ${lifetime}`,
    endpoints && `  endpoints: ${endpoints}`,
    access && `  access: ${access}`,
    // The exposures merged from the ledger while they are live (C14): held
    // work and granted reachability must both show on a read surface. A LINE
    // EACH, because an env may carry several names at once — a child answering
    // as its chat UI and as its governance dashboard is two holes, and one
    // `exposed:` line would have shown whichever the ledger happened to return
    // first while the other stayed invisible to every read surface.
    ...(env.exposures ?? []).map((row) => `  exposed: ${row.name} → ${row.url} (${row.service}:${row.port})`),
    env.state === 'claiming' && `  still provisioning — poll: ncl envs-get ${env.envId}`,
    env.state === 'released' && env.releaseCause && `  released: ${env.releaseCause}`,
    env.state === 'failed' && env.failureDetail && `  failed: ${env.failureDetail}`,
  ]
    .filter(Boolean)
    .join('\n');
}

registerResource({
  name: 'env',
  plural: 'envs',
  table: 'dev_envs',
  description:
    'Dev environment — a full live instance of a stamp, claimed from the configured driver. An agent claims as its own group and touches only envs its group owns.',
  idColumn: 'env_id',
  // No scopeField: every verb is a custom operation (never the generic
  // list/get row filter), and ownership scoping is derived in the handlers —
  // ownerFor/ownEnv, with a foreign env answering exactly like a missing one.
  columns: [
    {
      name: 'env_id',
      type: 'string',
      description: 'Opaque env handle, stable across instance replacement.',
      generated: true,
    },
    {
      name: 'owner_ref',
      type: 'string',
      description: 'Owning ref — derived: the claiming agent group, or "operator" for host claims.',
    },
    { name: 'stamp_id', type: 'string', description: 'Stamp this env instantiates.' },
    { name: 'state', type: 'string', description: 'Live state.', enum: ['claiming', 'active', 'failed', 'released'] },
    {
      name: 'lifetime',
      type: 'json',
      description: 'bound (rises and falls with the claiming sandbox), ttl (with deadline), or pinned.',
    },
    { name: 'endpoints', type: 'json', description: 'Named addresses, populated while the current instance is ready.' },
    { name: 'access', type: 'json', description: 'Named access-material paths (e.g. kubeconfig).' },
    { name: 'created_at', type: 'string', description: 'Auto-set.', generated: true },
    { name: 'release_cause', type: 'string', description: 'Why a released env ended.' },
    { name: 'failure_kind', type: 'string', description: 'Failure taxonomy kind, recorded when an env fails.' },
    { name: 'failure_detail', type: 'string', description: 'Human-readable failure cause, when the kind carries one.' },
    {
      name: 'claimant_session_id',
      type: 'string',
      description: 'Session notified when a still-provisioning claim settles (D18); null when nobody waits.',
    },
  ],
  operations: {},
  customOperations: {
    claim: {
      access: 'open',
      description:
        'Claim a dev environment: a full live instance of a stamp, from the configured driver. ' +
        'Lifetime bound (default, rises and falls with the claiming sandbox), ttl (extendable), or pinned (explicit release only). ' +
        'May return still-provisioning; agent claims are notified in-session when the claim settles (no need to poll), host callers poll envs-get. ' +
        'Flags: --stamp <id> (required) · --lifetime bound|ttl|pinned · --ttl <duration, e.g. 90m> (with --lifetime ttl) · ' +
        '--dev <path relative to your /workspace> (stamps that declare a dev block) · ' +
        '--options <json> (shape-changing claim options) · --owner <ref> (host callers only; agents always claim as their own group). ' +
        'Dev flavor: --dev <path> runs the child from that working tree — edits go live through the declared reload arm ' +
        '(see the dev-reload skill) instead of a re-registration. Refused at claim when the stamp declares no dev block.',
      handler: async (raw, ctx) => {
        const lifetimeMode = raw.lifetime === undefined ? 'bound' : String(raw.lifetime);
        if (lifetimeMode !== 'bound' && lifetimeMode !== 'ttl' && lifetimeMode !== 'pinned') {
          throw new Error(`--lifetime must be bound, ttl, or pinned; got "${lifetimeMode}"`);
        }
        if (lifetimeMode === 'ttl' && raw.ttl === undefined) throw new Error('--ttl is required for --lifetime ttl');
        const stamp = requireString(raw, 'stamp');
        const lifetime =
          lifetimeMode === 'ttl'
            ? ({ mode: 'ttl', ttlMs: parseDurationMs(raw.ttl) } as const)
            : ({ mode: lifetimeMode } as const);
        const options = resolveDevTreeOption(ctx, withDevSugar(raw, parseOptions(raw.options)));
        const owner = raw.owner === undefined ? undefined : String(raw.owner);
        return service().claim({
          ownerRef: ownerFor(ctx, owner),
          stampId: stamp,
          lifetime,
          options,
          // The D18 push address: derived from the transport-authenticated
          // caller, exactly like ownership — never a named argument. Host
          // callers have no session and keep the poll contract.
          ...(ctx.caller === 'agent' ? { claimantSessionId: ctx.sessionId } : {}),
        });
      },
      formatHuman: (data) => {
        const env = data as EnvSnapshot;
        // The D18 contract line, present exactly when the push is armed: an
        // in-flight claim will be TOLD when it settles, so the claiming agent
        // need not poll (the stamp-author guidance leans on this promise).
        return env.state === 'claiming' && env.claimantSessionId
          ? `${renderEnv(env)}\n  you will be notified in this session when it settles (active or failed) — no need to poll`
          : renderEnv(env);
      },
    },
    get: {
      access: 'open',
      description:
        'Status of one dev environment: state, endpoints, access, lifetime, and image provenance for ' +
        'registry-origin stamps. Usage: ncl envs get <env-id>.',
      handler: async (raw, ctx) => {
        const env = await ownEnv(ctx, requireString(raw, 'id'));
        return {
          ...env,
          imageProvenance: await imageProvenanceFor(env),
          exposures: (await getEnvExposureService()?.liveForEnv(env.envId)) ?? [],
        };
      },
      formatHuman: (data) => {
        const env = data as EnvSnapshot & { imageProvenance: string | null; exposures: ExposureRow[] };
        return env.imageProvenance ? `${renderEnv(env)}\n  image: ${env.imageProvenance}` : renderEnv(env);
      },
    },
    list: {
      access: 'open',
      description: 'List dev environments — an agent sees its own; the operator sees all. --live for unreleased only.',
      handler: async (raw, ctx) => {
        const envs = await service().list({
          ownerRef: ctx.caller === 'agent' ? ctx.agentGroupId : undefined,
          live: raw.live !== undefined,
        });
        // One query for every live grant, joined in memory: an exposure is a
        // hole a reader must see without a second command. Grouped rather than
        // keyed, because an env may hold more than one and a Map of single
        // rows would drop all but the last silently.
        const exposed = new Map<string, ExposureRow[]>();
        for (const row of (await getEnvExposureService()?.list()) ?? []) {
          exposed.set(row.envId, [...(exposed.get(row.envId) ?? []), row]);
        }
        return envs.map((env) => ({ ...env, exposures: exposed.get(env.envId) ?? [] }));
      },
      formatHuman: (data) => {
        const envs = data as Array<EnvSnapshot & { exposures: ExposureRow[] }>;
        return envs.length ? envs.map(renderEnv).join('\n') : 'no dev environments';
      },
    },
    release: {
      access: 'open',
      description:
        'Release a dev environment — full teardown of its instance. Idempotent. Usage: ncl envs release <env-id>.',
      handler: async (raw, ctx) => {
        const id = requireString(raw, 'id');
        await ownEnv(ctx, id);
        await service().release(id);
        return service().status(id);
      },
      formatHuman: (data) => renderEnv(data as EnvSnapshot),
    },
    extend: {
      access: 'open',
      description:
        'Extend a ttl environment: new deadline = now + --ttl. Only ttl envs extend. Usage: ncl envs extend <env-id> --ttl <duration>.',
      handler: async (raw, ctx) => {
        const id = requireString(raw, 'id');
        const ttlMs = parseDurationMs(requireString(raw, 'ttl'));
        await ownEnv(ctx, id);
        return service().extend(id, ttlMs);
      },
      formatHuman: (data) => renderEnv(data as EnvSnapshot),
    },
    expose: {
      // The one mutation on this resource that opens a hole in a perimeter,
      // so it carries the same declaration every stamps mutation does: the
      // guard HOLDs agent callers for the admin chain and the approved replay
      // re-runs this handler — by the time it executes, the grant IS approved.
      //
      // What the admin signed is THIS FRAME: `ncl envs expose <env-id>
      // --port N` plus `--service`/`--name` when the caller passed them,
      // which is all the card renders (approval-render.ts formats the command
      // and its args). The resolved service, the provider, the external port
      // and the URL are decided by the replay, AFTER the signature — the gate
      // says an admin approved opening port N of env E, not that they read
      // the URL first. Putting those on the card needs a pre-approval
      // prepare() hook in dispatch; deliberately not built here.
      access: 'approval',
      description:
        'Expose one port of a claimed env to a browser under a stable NAME (admin approval required). ' +
        'The grant binds to the name and the target (env + service + port), never to the transport — v1 carries ' +
        'it over the tailnet; a later provider carries the same name over DNS without a new grant model. ' +
        'The exposure DIES WITH ITS ENV: release, TTL reap, owner release, a failed instance or retiring the stamp ' +
        'all revoke it, unasked. Flags: --port <n> (required) · --service <name> (the target as ITS DRIVER names ' +
        'it — a child service `name` or `ns/name` on k8s, a stamp id or its container name on docker; omit and the ' +
        'one target serving that port is resolved and FROZEN at grant, two qualifying is a refusal) · ' +
        '--name <dns-label> (omit for a derived one). ' +
        'Whether the target speaks https on that port is PROBED once at grant and frozen — no flag to remember, ' +
        'and a target that does not answer refuses the grant rather than guessing (guessing plaintext for a ' +
        'target that was briefly down mints a URL that answers an empty 502 for good). ' +
        'An env may hold SEVERAL exposures — a child can answer as its UI and as its dashboard at once; the NAME ' +
        'is what must be unique while it is live, so a second port of the same service wants its own --name. ' +
        'Usage: ncl envs expose <env-id> --port 8080.',
      handler: async (raw, ctx) => {
        const id = requireString(raw, 'id');
        await ownEnv(ctx, id);
        return exposureService().expose({
          envId: id,
          port: requirePort(raw),
          service: raw.service === undefined ? undefined : String(raw.service).trim(),
          name: raw.name === undefined ? undefined : String(raw.name).trim().toLowerCase(),
          // Derived from the transport-authenticated caller, exactly like
          // ownership — an approved replay carries the original caller.
          approvedBy: authorFor(ctx),
          // The push address (#223): only an UNASKED transition is pushed —
          // a grant's own answer is already in this response.
          ...(ctx.caller === 'agent' ? { claimantSessionId: ctx.sessionId } : {}),
        });
      },
      formatHuman: (data) => renderExposure(data as ExposureRow),
    },
    unexpose: {
      // Deliberately open, the same asymmetry release has: closing a hole
      // needs no ceremony, and requiring approval to CLOSE one would be a
      // reason to leave it open.
      access: 'open',
      description:
        "Close an env's exposures — the URL stops serving and the row records the ending. Idempotent. " +
        "Closes ALL of the env's exposures; --name <dns-label> closes exactly one and leaves the rest live. " +
        'Usage: ncl envs unexpose <env-id> [--name <dns-label>].',
      handler: async (raw, ctx) => {
        const id = requireString(raw, 'id');
        await ownEnv(ctx, id);
        // Same normalization the grant used, so a name types the same way in
        // both commands rather than silently missing on case.
        const name = raw.name === undefined ? undefined : String(raw.name).trim().toLowerCase();
        return { envId: id, name: name ?? null, exposures: await exposureService().unexpose(id, name) };
      },
      formatHuman: (data) => {
        const { envId, name, exposures } = data as { envId: string; name: string | null; exposures: ExposureRow[] };
        if (exposures.length) return exposures.map(renderExposure).join('\n');
        // Which nothing: an env with no holes at all, or no hole by that name.
        // Both are idempotent successes, and telling them apart is how a typo'd
        // --name stops reading as "already closed".
        return name ? `env ${envId} exposes nothing named '${name}'` : `env ${envId} exposes nothing`;
      },
    },
  },
});
