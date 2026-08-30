/**
 * Stamps — the registry surface (C12): a stamp becomes a runtime resource an
 * agent can propose and a human approves, instead of boot-time configuration.
 *
 * Every mutation here is `access: 'approval'`: the command guard HOLDs agent
 * callers for the admin chain and the approved replay re-runs the handler
 * carrying the grant — so by the time a handler executes, the registration IS
 * approved, and the row lands active. Host callers pass the guard directly
 * (trusted socket), which is also what makes the approval flow's own replay
 * path work. Structural validation runs in the store on every write — the
 * same refusals the driver's constructor earns, delivered at registration in
 * front of the approver, never later as a boot timeout.
 *
 * Reads are open. `list` also names rows the source's last refresh EXCLUDED
 * as invalid (a row predating a validation rule) — an excluded stamp must be
 * visible as excluded, never silently unclaimable. And a row's pool renders in
 * BOTH halves — the size the author asked for, and the slots the driver is
 * holding for it, corpses included — because an approved mutation nobody can
 * verify is how the probe-claim workaround gets invented, and a pool that only
 * ever renders capacity hides the one state worth acting on (renderPool, #21).
 */
import fs from 'node:fs';
import path from 'node:path';

import {
  BUILTIN_STAMPS,
  getEnvExposureService,
  getStampRegistry,
  pinImageConfig,
  placeRef,
  readinessGates,
  stampImageOrigin,
  validateStampEntry,
  type K8sStampConfig,
} from '../../dev-env/index.js';
import { log } from '../../log.js';
import type { StampImageRow } from '../../dev-env/stamp-images.js';
import type { NodeImageStatus, PoolObservation, PoolReading, StampRow } from '../../dev-env/stamp-registry.js';
import type { CallerContext } from '../frame.js';
import { registerResource } from '../crud.js';

function registry(): NonNullable<ReturnType<typeof getStampRegistry>> {
  const reg = getStampRegistry();
  if (!reg) {
    throw new Error('dev-env is not enabled on this host — set NANOCLAW_DEV_ENV_DRIVER and restart the service.');
  }
  return reg;
}

/** This row's slice of a `PoolReading` — the same three answers, narrowed to one stamp. */
type RowPool = ({ state: 'observed' } & PoolObservation) | { state: 'unpooled' } | { state: 'unreadable' };

/**
 * A stamp row with what the render needs beside it: the CURRENT version's
 * placement row, the pool as the driver observes it, and the node-image
 * verdict from the source's last refresh. The placement row and the
 * node-image verdict are the two GATE STATES that decide whether a claim of
 * this stamp can succeed right now; all three travel in the payload rather
 * than being looked up in `formatHuman`, which may run on the far side of the
 * socket from the registry.
 */
type StampView = StampRow & {
  image: StampImageRow | null;
  pool: RowPool;
  nodeImages: NodeImageStatus | null;
};

/**
 * An observed pool with no entry for this id is holding nothing for it —
 * zeros, not silence. Silence is only ever "nobody counted", and its two
 * shapes stay apart all the way to the render (see `PoolReading`).
 */
function rowPool(reading: PoolReading, stampId: string): RowPool {
  if (reading.state !== 'observed') return reading;
  return { state: 'observed', ...(reading.pools[stampId] ?? { warm: 0, filling: 0, draining: 0, failed: 0 }) };
}

/**
 * `reading` defaults to one observation per call, which is right for the
 * single-row verbs; `list` takes ITS one and hands the same answer to every
 * row, so a listing costs one runtime query, not one per stamp.
 */
async function stampView(row: StampRow, reading = registry().observePools()): Promise<StampView> {
  const pool = rowPool(reading, row.stampId);
  const { images, source } = registry();
  const nodeImages = source.nodeImageStatus(row.stampId);
  if (stampImageOrigin(row.config).kind !== 'pull') return { ...row, image: null, pool, nodeImages };
  return { ...row, image: (await images.get(row.stampId, row.version)) ?? null, pool, nodeImages };
}

/**
 * The C15 write path shared by create and update: refuse cheap structural
 * faults first (so a resolver is never consulted about garbage), refuse an
 * origin the installed driver cannot realize (the author learns in seconds;
 * the approver never sees an unrealizable stamp), then resolve-and-pin — the
 * approval signs `<ref>@<digest>`, bits not a tag. Registry refusals carry
 * the registry's own message (the resolver throws it).
 */
async function pinnedForWrite(stampId: string, config: K8sStampConfig): Promise<K8sStampConfig> {
  const { resolveImage, driverCapabilities } = registry();
  validateStampEntry(stampId, config, { allowUnpinned: true });
  if (stampImageOrigin(config).kind === 'pull') {
    const capabilities = driverCapabilities();
    if (capabilities && !capabilities.imagePull) {
      throw new Error(
        `this deployment's driver does not realize the pull origin (imagePull: false) — ` +
          `declare presence: 'node-local' for an operator-imported image`,
      );
    }
    return pinImageConfig(config, resolveImage);
  }
  return config;
}

/**
 * The approved row's pending image row (C15): row existence IS the approval,
 * inserted by the approved handler itself — pre-approval nothing exists for
 * a placement or a claim to find. The registering session rides the row so
 * placement completion notifies it the way claim completion does.
 */
async function insertPendingImage(row: StampRow, ctx: CallerContext): Promise<void> {
  const origin = stampImageOrigin(row.config);
  if (origin.kind !== 'pull') return;
  const { images } = registry();
  await images.insertPending({
    stampId: row.stampId,
    version: row.version,
    origin: 'pull',
    ref: placeRef(row.stampId, row.version),
    sourceRef: origin.ref,
    claimantSessionId: ctx.caller === 'agent' ? ctx.sessionId : null,
  });
}

function authorFor(ctx: CallerContext): string {
  return ctx.caller === 'agent' ? ctx.agentGroupId : 'operator';
}

function requireString(raw: Record<string, unknown>, key: string): string {
  const value = raw[key];
  if (typeof value !== 'string' || !value.trim()) throw new Error(`--${key} is required`);
  return value.trim();
}

/**
 * `--config` / `--source` arrive two ways: as inline JSON text on argv, or as
 * an already-parsed object when the caller shipped them via `--stdin-json` —
 * the merge hands structured values through as-is, and an approved replay
 * re-runs the handler on the stored frame, where they are objects too. Both
 * routes land on the same structural check; a non-object is refused before
 * the store sees it. (Live incident appr-1787499645710-fkkq95: the
 * string-only parse refused an approved `stamps create` for carrying exactly
 * the object the flag documents.)
 */
function jsonObjectArg(raw: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = raw[key];
  if (value === undefined || (typeof value === 'string' && !value.trim())) {
    throw new Error(`--${key} is required`);
  }
  let parsed: unknown = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value);
    } catch (error) {
      throw new Error(`--${key} must be a JSON object (inline or via --stdin-json)`, { cause: error });
    }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`--${key} must be a JSON object (inline or via --stdin-json)`);
  }
  return parsed as Record<string, unknown>;
}

/**
 * A wrong path read whole is worse news than a refusal, so the file form
 * carries a named ceiling — roughly thirty times the largest stamp anyone has
 * registered. This is the "you pointed at the wrong thing" guard (a log, a
 * tarball, a device) and not a statement about stamps; unlike the execve cap
 * it exists to replace, it fires with the path, the size, and the limit in the
 * message.
 */
const MAX_JSON_FILE_BYTES = 4 * 1024 * 1024;

/**
 * The FILE form of the two JSON-object flags: `--config-file <path>`,
 * `--source-file <path>`.
 *
 * WHY IT EXISTS. `--config '<json>'` is ONE argv string, and argv strings are
 * capped by the kernel at MAX_ARG_STRLEN = 32 × PAGE_SIZE = 131_072 bytes. The
 * cap is enforced by execve, so it fires BEFORE `ncl` exists: the shell says
 * `Argument list too long`, and nothing names the stamp, the flag, or the
 * ceiling — there is no process yet to name them. A deployment-shaped stamp
 * (the `childManifests` of a whole governed child) is already ~66 KB and its
 * dev flavour ~131 KB, so the exact shapes this registry exists to carry are
 * the ones that cannot be passed. `--stdin-json` does not reach them either:
 * it caps at MAX_STDIN_JSON_BYTES (64 KiB), half of what the dev flavour needs.
 *
 * The silence is the expensive half. In a scripted register→claim cycle the
 * dead `stamps update` is followed by an `envs claim` that SUCCEEDS — against
 * the PREVIOUS version, which is still registered — so acceptance runs green
 * against a stale manifest. That has happened, and it cost a full session.
 *
 * WHO MAY PASS A PATH, AND WHY THAT IS THE WHOLE DESIGN. A path is not a
 * value: it is a promise to look something up later, and both of the things
 * that break that promise land on this surface.
 *
 * TIME. `create` and `update` are `access: 'approval'`. An agent caller's
 * request is HELD, and dispatch stores the request frame verbatim
 * (`payload: { frame: { id, command, args } }` — the args exactly as they
 * arrived, before any handler runs). THE FRAME IS THE DURABLE SUBJECT: the
 * card, the approval record, and the replay are all readings of it, and no
 * rendering can show more than it carries. (Which rendering varies — verbatim
 * `--<flag> <value>` from dispatch's own `argSummary`, or, where the
 * `approval-card-elides-args` skill is installed, a document-sized value
 * replaced on the card by its size, with the approver reading the full value
 * off the `pending_approvals` row. Both read the same stored args, which is
 * exactly why what those args ARE decides this.) A frame carrying
 * `--config-file /workspace/stamp.json` therefore leaves every one of those
 * surfaces holding a FILENAME and never a manifest: the approver signs a name
 * over bytes that are nowhere in the record, and the approved replay re-runs
 * this handler on the stored frame minutes or hours later and reads the file
 * THEN — by which time one `echo >` in an agent-writable workspace has changed
 * what was approved. An approval that cannot see its subject is not an
 * approval.
 *
 * FILESYSTEM. This handler always runs in the HOST daemon, whatever transport
 * carried the frame: a container's `ncl` writes a cli_request into its mailbox
 * and the host dispatches it. So a path typed inside a sandbox is resolved
 * against the host root — at best ENOENT, at worst a real host file read with
 * the daemon's privileges and handed straight back to the agent by
 * `stamps get`. `envs claim --dev` answers this one by deriving the base from
 * the caller's authenticated session (`resolveDevTreeOption` in envs.ts), and
 * the same trick would work here — but it fixes only the second hazard, and
 * the first is fatal on its own.
 *
 * So the file form belongs to the TRUSTED SOCKET: the operator, and the
 * scripted acceptance cycle this flag exists for. A host caller is never held
 * (dispatch refuses to hold a non-agent caller), so its handler runs in the
 * same breath as the invocation, against its own filesystem — handler time IS
 * parse time, and there is no window for the file to change in.
 *
 * WHAT WOULD LIFT THE RESTRICTION: resolving the path to its CONTENT before
 * the frame is built, in the client — which is exactly what `--spec-stdin`
 * does for `groups create` (`resolveCreateSpecStdin` rewrites args client-side
 * so "the daemon receives the same stable request frame it would receive if
 * every value came from argv"). Then the stored frame carries the config, the
 * card shows it, and the replay registers what the approver read. That seam
 * lives in the two clients, not here: a `CustomOperation` owns a handler, and
 * the handler is downstream of the hold — this module has no hook that runs
 * before the card is minted. Which is also why the refusal below lands at
 * REPLAY rather than at request: an agent that tries the flag spends one
 * approval round-trip to learn it is not theirs, and the message says so.
 *
 * ABSOLUTE ONLY. `ncl` is a socket client — it sends a frame and the DAEMON
 * opens the file — so a relative path resolves against the service's working
 * directory, not the shell's. `--config-file ./stamp.json` would usually fail,
 * and the reason it is refused rather than resolved is the time it would not:
 * a `stamp.json` sitting beside the daemon would be read instead, silently, in
 * place of the one the operator is looking at.
 */
function readJsonObjectFile(key: string, value: unknown, ctx: CallerContext): Record<string, unknown> {
  const flag = `--${key}-file`;
  if (ctx.caller !== 'host') {
    throw new Error(
      `${flag} is host-only: the approval card renders the frame it holds, so a path would show the approver a ` +
        `filename instead of the manifest — and the file is re-read on the far side of the socket, on the host's ` +
        `filesystem, after approval. Pass --${key} (inline or via --stdin-json) so the bytes ride in the frame you ` +
        `are asking someone to sign.`,
    );
  }
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${flag} needs a path to a JSON file`);
  const target = value.trim();
  if (!path.isAbsolute(target)) {
    throw new Error(
      `${flag} needs an ABSOLUTE path, got '${target}' — the host daemon opens this file, not your shell, so a ` +
        `relative path resolves against the service's working directory and could read a different file entirely`,
    );
  }
  const resolved = path.resolve(target);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(resolved);
  } catch (error) {
    throw new Error(`${flag}: cannot read ${resolved} — ${reason(error)}`, { cause: error });
  }
  if (!stat.isFile()) throw new Error(`${flag}: ${resolved} is not a regular file`);
  if (stat.size > MAX_JSON_FILE_BYTES) {
    throw new Error(
      `${flag}: ${resolved} is ${stat.size} bytes, over the ${MAX_JSON_FILE_BYTES}-byte ceiling — a stamp is tens ` +
        `of kilobytes, so this is almost certainly not the file you meant`,
    );
  }
  let text: string;
  try {
    text = fs.readFileSync(resolved, 'utf8');
  } catch (error) {
    throw new Error(`${flag}: cannot read ${resolved} — ${reason(error)}`, { cause: error });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    // The parser's own message carries the offset, which is the only thing
    // that makes a 66 KB manifest's syntax error findable.
    throw new Error(`${flag}: ${resolved} is not valid JSON — ${reason(error)}`, { cause: error });
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${flag}: ${resolved} must hold a JSON object, got ${jsonKind(parsed)}`);
  }
  return parsed as Record<string, unknown>;
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** What the file actually held, in the words a reader would use for it. */
function jsonKind(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  return `a ${typeof value}`;
}

/**
 * One JSON-object argument from whichever of its forms the caller used —
 * `--<key>` (inline text, or an already-parsed object via `--stdin-json`) or
 * `--<key>-file <path>`.
 *
 * Both together is REFUSED, never resolved by precedence: the two forms are
 * two different manifests as far as this command can tell, and picking one
 * silently is how the version you did not read gets approved and registered.
 * `--spec-stdin` refuses its own pair for the same reason. The refusal is
 * first because it is the cheapest fault here — no filesystem, no parse.
 *
 * `raw` is underscore-normalized by the time a handler sees it (crud.ts's
 * `normalizeArgs`), so `--config-file` arrives as `config_file`; the flag
 * names in every message are spelled the way a caller types them.
 */
function jsonObjectArgOrFile(raw: Record<string, unknown>, key: string, ctx: CallerContext): Record<string, unknown> {
  const file = raw[`${key}_file`];
  if (raw[key] !== undefined && file !== undefined) {
    throw new Error(
      `--${key} and --${key}-file are the same argument twice — pass exactly one, so what gets registered is the ` +
        `one you read`,
    );
  }
  if (file !== undefined) return readJsonObjectFile(key, file, ctx);
  if (raw[key] === undefined) throw new Error(`--${key} is required (or --${key}-file <absolute path>)`);
  return jsonObjectArg(raw, key);
}

/** The same two forms for an OPTIONAL argument: absent means absent, not empty. */
function optionalJsonObjectArgOrFile(
  raw: Record<string, unknown>,
  key: string,
  ctx: CallerContext,
): Record<string, unknown> | undefined {
  if (raw[key] === undefined && raw[`${key}_file`] === undefined) return undefined;
  return jsonObjectArgOrFile(raw, key, ctx);
}

function renderStamp(row: StampView): string {
  // Every declared gate, named: a whole-deployment stamp is ready only when
  // ALL of them are Available, and an approver reading one name where three
  // were signed would be reading the wrong contract.
  const gates = readinessGates(row.config).map((gate) => `${gate.namespace}/${gate.deployment}`);
  const parts = [
    `${row.stampId}  v${row.version}  ${row.state}  ${renderPool(row)}  author=${row.authorRef}`,
    row.source && `  source: ${JSON.stringify(row.source)}`,
    `  shape: ${row.config.childManifests !== undefined ? 'childManifests' : row.config.app ? 'app' : 'bare vcluster'}` +
      (gates.length ? `  readiness: ${gates.join(', ')}` : ''),
    renderNodeImages(row),
    renderDev(row.config),
    renderImage(row),
  ];
  return parts.filter(Boolean).join('\n');
}

/**
 * The node-image gate's STATE, rendered the way the placement state is — because
 * this gate closes a pool and drains its warm slots, and a claim gate an
 * operator cannot see is one they debug as a boot timeout.
 *
 * Three readings, never collapsed into two: MISSING (the gate is shut and says
 * which images to import), present (checked, and there), and unchecked — no
 * driver answers the probe or it failed this cycle, so the declaration gates
 * nothing at all. Rendering the third as "present" would sell an assertion
 * nobody made.
 */
function renderNodeImages(row: StampRow & { nodeImages?: NodeImageStatus | null }): string | null {
  const declared = row.config.nodeImages ?? [];
  if (declared.length === 0) return null;
  const status = row.nodeImages;
  if (!status || !status.checked) {
    // Null covers a row the claimable table does not carry (retired, excluded);
    // unchecked covers no driver verb and a probe that could not answer. Both
    // mean the same thing to a reader: nobody asked, so nothing is gated.
    return (
      `  nodeImages: UNCHECKED — nothing answered the node probe, so the assertion gates nothing; ` +
      `the node must already hold: ${declared.join(', ')}`
    );
  }
  if (status.missing.length === 0) return `  nodeImages: in the node store — ${declared.join(', ')}`;
  return (
    `  nodeImages: MISSING ${status.missing.length} of ${declared.length} — claims refused by name and the warm ` +
    `pool stopped: ${status.missing.join(', ')} (import on the node: docker save | ctr images import)`
  );
}

/**
 * The pool in both halves: `poolSize` is what the author ASKED for, the
 * observation is what the driver is actually holding — `pool=1 (warm 1)`,
 * `pool=1 (warm 0, filling 1)`, `pool=0 (warm 0, draining 1)` while a retire
 * or a shrink drains. Warm always leads: "how many claims land instantly" is
 * the number being read, and a zero rendered as absence is the ambiguity this
 * line exists to kill.
 *
 * The desired half alone is what made `set-pool` unverifiable: it flips the
 * instant approval lands, the fill it schedules is a minute behind it, and
 * pool slots are owned by nobody — so they surface on no env list either. The
 * agent that hit that wall measured the fill by CLAIMING a slot, and the
 * refill its release scheduled raced the retire eight seconds later into
 * ISSUES #21's reason-less failed row. Now the read command answers.
 *
 * Three answers, not two, because the alternatives are not the same news:
 * - `unpooled` (`pool=1`) — nothing pools here; the line reads exactly as it
 *   did before the observed half existed.
 * - `unreadable` (`pool=1 (slots unreadable)`) — there IS a pool and the
 *   runtime did not answer. Rendering that as `unpooled` would tell an author
 *   "nothing to see" about a count nobody could take; rendering it as zeros
 *   would invent a measurement.
 */
function renderPool(row: StampView): string {
  if (row.pool.state === 'unreadable') return `pool=${row.poolSize} (slots unreadable)`;
  if (row.pool.state === 'unpooled') return `pool=${row.poolSize}`;
  const { warm, filling, draining, failed, lastFailureAgeMs } = row.pool;
  // Nothing desired and nothing held is the whole story; the parenthetical
  // would only add noise to every stamp that never asked for a pool.
  if (row.poolSize === 0 && warm + filling + draining + failed === 0) return 'pool=0';
  const counts = [`warm ${warm}`, filling && `filling ${filling}`, draining && `draining ${draining}`]
    .filter(Boolean)
    .join(', ');
  return `pool=${row.poolSize} (${counts})${renderDeadFills(failed, lastFailureAgeMs)}`;
}

/**
 * Dead fills, kept OUT of the parenthetical and dated — because they are not a
 * live state and a row that spelled them like one could not be trusted.
 * Nothing reaps a pool corpse, so `failed` only ever grows: rendered beside
 * warm and filling it made a pool that recovered an hour ago read as a pool
 * failing right now, and permanent bad news is read as no news.
 *
 * `pool=1 (warm 0, filling 1) — 2 dead fills, last 20s ago` is a stamp that
 * cannot boot: stop waiting. `pool=1 (warm 1) — 2 dead fills, last 3h ago` is
 * the same two corpses after the pool came back, which is a note, not an
 * alarm. The age is what tells them apart, and it is the whole reason the
 * count carries one.
 */
function renderDeadFills(failed: number, ageMs: number | undefined): string {
  if (failed === 0) return '';
  const fills = `${failed} dead ${failed === 1 ? 'fill' : 'fills'}`;
  // Undated corpses predate the timestamp (or lost the annotate); the count
  // still says the fills died, it just cannot say when.
  return ageMs === undefined ? ` — ${fills}` : ` — ${fills}, last ${renderAgo(ageMs)}`;
}

/** Coarse on purpose: the reader is deciding "news or history", not measuring. */
function renderAgo(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return `${Math.floor(ms / 1_000)}s ago`;
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`;
}

/**
 * The dev line (C16): the opt-in is part of the approved config, so the row
 * says it — the variant's shape and the declared reload arm are what a
 * claimer (and the generic dev-reload skill) reads off `stamps get`.
 */
function renderDev(config: K8sStampConfig): string | null {
  const dev = config.dev;
  if (!dev) return null;
  const variant = 'manifests' in dev ? 'authored dev manifests' : `tree mounts at ${dev.mountPath}`;
  // The consumer, whenever the stamp names one: on a multi-gate stamp it is
  // WHICH of the declared legs the hot loop actually runs from a tree, and a
  // reader who cannot see that is reading a dev line that could mean any of
  // three things.
  const consumer =
    'manifests' in dev && dev.consumer ? `  consumer=${dev.consumer.namespace}/${dev.consumer.deployment}` : '';
  return `  dev: ${variant}${consumer}  reload=${dev.reload?.kind ?? 'rollout'} (claim with envs claim --dev <path>)`;
}

/**
 * The image line (C15): origin in words, placement state with its age — a
 * wedged placement must read as "pulling since <t>", never as an eternal
 * state — and a same-version digest change surfaced LOUDLY, never absorbed.
 */
function renderImage(row: StampRow & { image?: StampImageRow | null }): string | null {
  const origin = stampImageOrigin(row.config);
  if (origin.kind === 'none') return null;
  if (origin.kind === 'node-local') {
    // The explicit opt-out says so on the row: this is the operator-hands
    // path, chosen — the claim/import race lives here and nowhere else now.
    return '  image: node-local (operator-managed; no placement, claims find it or not)';
  }
  const image = row.image;
  if (!image) {
    return `  image: registry — NO placement record (predates the image path); ncl stamps place ${row.stampId} queues it`;
  }
  const lines: string[] = [];
  if (image.state === 'placed') {
    lines.push(`  image: placed ${image.digest ?? '?'}`);
    lines.push(`  provenance: pulled from ${image.sourceRef}`);
  } else if (image.state === 'placing') {
    lines.push(`  image: pulling since ${image.startedAt ?? image.createdAt} — claims refused until placed`);
  } else if (image.state === 'pending') {
    lines.push(`  image: pending since ${image.createdAt} — claims refused until placed`);
  } else {
    lines.push(
      `  image: FAILED — ${image.error ?? 'no reason recorded'} (ncl stamps place ${row.stampId} re-runs the approved pull)`,
    );
  }
  if (image.priorDigest && image.digestChangedAt) {
    lines.push(`  DIGEST CHANGED at ${image.digestChangedAt}: was ${image.priorDigest}, now ${image.digest ?? '?'}`);
  }
  return lines.join('\n');
}

registerResource({
  name: 'stamp',
  plural: 'stamps',
  table: 'stamp_registry',
  description:
    'Registered environment stamps — manifests agents author and register (with approval) so a project becomes ' +
    'claimable via ncl envs claim. Code-provided stamps (the builtin table) shadow same-id rows and cannot be ' +
    'registered over.',
  idColumn: 'stamp_id',
  columns: [
    { name: 'stamp_id', type: 'string', description: 'Stamp id — k8s-label-legal; names the claim target.' },
    {
      name: 'config',
      type: 'json',
      description:
        'The stamp definition: {app: {image, port, …}} or {childManifests, readiness} — readiness may be a LIST ' +
        'of {deployment, namespace} when one stamp realizes several components. Neither = bare vcluster. ' +
        'Optional nodeImages: [refs the node must already hold].',
    },
    {
      name: 'pool_size',
      type: 'number',
      description:
        'Warm slots to KEEP; takes effect within one reconcile. get/list render the observed slots beside it.',
    },
    { name: 'version', type: 'number', description: 'Increments per approved update; claims record it.', generated: true },
    { name: 'state', type: 'string', description: 'Lifecycle state.', enum: ['active', 'retired'] },
    { name: 'author_ref', type: 'string', description: 'Who registered it — derived, never trusted.', generated: true },
    { name: 'source', type: 'json', description: 'Freeform provenance (repo, revision, path…).' },
    { name: 'created_at', type: 'string', description: 'Auto-set.', generated: true },
    { name: 'updated_at', type: 'string', description: 'Auto-set.', generated: true },
  ],
  operations: {},
  customOperations: {
    create: {
      access: 'approval',
      description:
        'Register a stamp so it becomes claimable (admin approval required). ' +
        "Flags: --id <stamp-id> · --config '<json>' ({app: {image, port, …}} or {childManifests, readiness}; "
        + 'readiness may be a list, and nodeImages asserts what the node must already hold). ' +
        'A fully-qualified app image is the registry PULL path: resolution pins it to a digest at the approved ' +
        "write and the platform places it before claims open; presence: 'node-local' opts out (image must already " +
        "be on the node). An optional dev block opts the stamp into working-tree claims (envs claim --dev) — " +
        "{mountPath, …} for app shape, {manifests, …} for childManifests (see the stamp-author skill for the " +
        "identity-token clamp) · --source '<json>' (optional provenance: repo, revision, path). " +
        'A deployment-shaped config does not FIT in one argv string (the kernel caps it at 131_072 bytes and ' +
        'execve refuses before ncl runs, naming nothing): from the host CLI pass --config-file <absolute path> ' +
        'instead — same JSON, read from the file — and --source-file <absolute path> beside it. Agents pass ' +
        '--config, inline or via --stdin-json: a held approval card can only show the approver what the frame ' +
        'carries, and a path is not the manifest.',
      handler: async (raw, ctx) => {
        const { store, source } = registry();
        const stampId = requireString(raw, 'id');
        const config = await pinnedForWrite(stampId, jsonObjectArgOrFile(raw, 'config', ctx) as K8sStampConfig);
        const row = await store.create({
          stampId,
          config,
          authorRef: authorFor(ctx),
          source: optionalJsonObjectArgOrFile(raw, 'source', ctx),
        });
        await insertPendingImage(row, ctx);
        await source.refresh();
        return stampView(row);
      },
      formatHuman: (data) => renderStamp(data as StampView),
    },
    get: {
      access: 'open',
      description:
        'One registered stamp: definition shape, version, pool (desired size plus what the driver is actually ' +
        'holding — warm/filling/draining, and any dead fills it left behind, dated), state, and its image ' +
        'placement (origin, state, provenance). Usage: ncl stamps get <stamp-id>.',
      handler: async (raw) => {
        const row = await registry().store.get(requireString(raw, 'id'));
        if (!row) throw new Error(`no stamp '${String(raw.id)}' in the registry`);
        return stampView(row);
      },
      formatHuman: (data) => renderStamp(data as StampView),
    },
    list: {
      access: 'open',
      description: 'List registered stamps. --live for active only. Code-provided stamps are listed by id for reference.',
      handler: async (raw) => {
        const { store, source, observePools } = registry();
        const rows = await store.list(raw.live !== undefined ? { state: 'active' } : {});
        const reading = observePools();
        return {
          rows: await Promise.all(rows.map((row) => stampView(row, reading))),
          builtin: Object.keys(BUILTIN_STAMPS),
          invalid: source.invalid(),
        };
      },
      formatHuman: (data) => {
        const { rows, builtin, invalid } = data as { rows: StampView[]; builtin: string[]; invalid: string[] };
        return [
          rows.length ? rows.map(renderStamp).join('\n') : 'no registered stamps',
          `code-provided (claimable, not registry-managed): ${builtin.join(', ')}`,
          invalid.length ? `EXCLUDED as invalid (fix via stamps update): ${invalid.join(', ')}` : null,
        ]
          .filter(Boolean)
          .join('\n');
      },
    },
    update: {
      access: 'approval',
      description:
        'Register a new definition under an existing id (admin approval required); the version increments and new ' +
        'claims realize it. A registry-origin update is unclaimable until its NEW image places — prior versions keep ' +
        "their placement rows forever. Flags: --id <stamp-id> · --config '<json>' · --source '<json>' (optional). " +
        'Host CLI: --config-file <absolute path> / --source-file <absolute path> read the same JSON from a file, ' +
        'which is the only route for a definition over ~131 KB (argv is capped by execve). One form per ' +
        'argument — --config with --config-file is refused, never resolved by precedence.',
      handler: async (raw, ctx) => {
        const { store, source } = registry();
        const stampId = requireString(raw, 'id');
        const config = await pinnedForWrite(stampId, jsonObjectArgOrFile(raw, 'config', ctx) as K8sStampConfig);
        const row = await store.update(stampId, config, optionalJsonObjectArgOrFile(raw, 'source', ctx));
        await insertPendingImage(row, ctx);
        await source.refresh();
        return stampView(row);
      },
      formatHuman: (data) => renderStamp(data as StampView),
    },
    place: {
      access: 'open',
      description:
        'Re-queue a registry-origin image placement — re-executes ONLY the origin the approval already signed ' +
        '(no new approval; the digest never changes). From failed (or a lost record): any caller. From placed: ' +
        'host only — that flip makes a claimable stamp unclaimable, and an any-caller version would be an ' +
        'approval-free off switch platform-wide. Usage: ncl stamps place <stamp-id>.',
      handler: async (raw, ctx) => {
        const { store, images, source } = registry();
        const stampId = requireString(raw, 'id');
        const row = await store.get(stampId);
        if (!row) throw new Error(`no stamp '${stampId}' in the registry`);
        if (row.state === 'retired') throw new Error(`stamp '${stampId}' is retired — nothing places for it`);
        const origin = stampImageOrigin(row.config);
        if (origin.kind !== 'pull') {
          throw new Error(
            `stamp '${stampId}' has no registry origin (${origin.kind === 'node-local' ? "presence: 'node-local'" : 'no app image'}) — nothing to place`,
          );
        }
        const image = await images.get(stampId, row.version);
        if (!image) {
          // The heal for a lost/predating record: re-queue what the approved
          // config already signs (its image is digest-pinned) — any caller,
          // same ground as re-place-from-failed.
          await images.insertPending({
            stampId,
            version: row.version,
            origin: 'pull',
            ref: placeRef(stampId, row.version),
            sourceRef: origin.ref,
            claimantSessionId: ctx.caller === 'agent' ? ctx.sessionId : null,
          });
        } else if (image.state === 'failed') {
          await images.resetToPending(stampId, row.version);
        } else if (image.state === 'placed') {
          if (ctx.caller !== 'host') {
            throw new Error(
              `'${stampId}' v${row.version} is placed — re-placing a placed image makes it unclaimable meanwhile, ` +
                'so only the host operator may (agents: nothing to do, the stamp is claimable)',
            );
          }
          await images.resetToPending(stampId, row.version);
        } else {
          throw new Error(`'${stampId}' v${row.version} is already ${image.state} — the reconciler owns it from here`);
        }
        await source.refresh();
        return stampView((await store.get(stampId))!);
      },
      formatHuman: (data) => renderStamp(data as StampView),
    },
    retire: {
      access: 'approval',
      description:
        'Retire a stamp (admin approval required): new claims refuse it, its pool drains, live envs keep running. ' +
        'Any port those envs EXPOSE is revoked — an exposure is a hole approved against a named definition, and ' +
        "withdrawing the definition withdraws the approval's subject (the env itself is untouched). " +
        'Retired rows stay — claims recorded their version. Usage: ncl stamps retire <stamp-id>.',
      handler: async (raw) => {
        const { store, source } = registry();
        const stampId = requireString(raw, 'id');
        const row = await store.retire(stampId);
        await source.refresh();
        // C14: the reachability granted onto these bits ends with the
        // registration that named them. Guarded — a revoke blip must not turn
        // an approved retire into a failure, and the retire itself has already
        // landed. THERE IS NO COMPENSATOR HERE, and none is owed: nothing
        // re-reads stamp state, so `revokeForStamp` finishes the job itself —
        // it guards each row so one failure cannot abandon the others, and it
        // names every row it could not close in the log WITH THE REMEDIATION
        // THAT ROW ACTUALLY NEEDS (a retry for a ledger write that missed; the
        // provider's heal sweep, not a command, for a transport that refused
        // teardown under an already-ended row). This outer catch is for the
        // whole call failing — no env list, no ledger — which leaves nothing
        // named at all, and so says so.
        await getEnvExposureService()
          ?.revokeForStamp(stampId)
          .catch((error) =>
            log.warn('Dev-env: retiring the stamp did not close every exposure onto it; close them by hand', {
              stamp: stampId,
              error: String(error),
            }),
          );
        // The pool render is taken AFTER the revoke, so a retire's row shows
        // the drain that has already begun rather than the pool it had a
        // moment ago (renderPool, #21).
        return stampView(row);
      },
      formatHuman: (data) => renderStamp(data as StampView),
    },
    'set-pool': {
      access: 'approval',
      description:
        'Set the warm-slot count for a registered stamp (admin approval required for agent callers); takes effect ' +
        'within one pool reconcile — up for a raise, drained down for a cut. Watch it land with ncl stamps get ' +
        '<stamp-id> — it renders the size you asked for beside the slots the driver holds (warm/filling/draining) ' +
        'and any dead fills, dated; claiming an env to find out is never the way. ' +
        'Usage: ncl stamps set-pool <stamp-id> --size <n>.',
      handler: async (raw) => {
        const { store, source } = registry();
        const size = Number(requireString(raw, 'size'));
        const row = await store.setPool(requireString(raw, 'id'), size);
        await source.refresh();
        return stampView(row);
      },
      formatHuman: (data) => renderStamp(data as StampView),
    },
  },
});
