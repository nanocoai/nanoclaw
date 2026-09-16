/**
 * Session driver seam — shared contract types.
 *
 * The host composes a fully-resolved `SessionSpec`; a driver realizes it and
 * reports. Drivers never compute, look up, or decide: if a driver needs to
 * figure something out, the spec is underspecified.
 *
 * Mounts live on ContainerSpec, not the session: an auxiliary container needs its material
 * mounts and the agent needs its workspace mounts, and neither may see the
 * other's.
 */

export interface SessionKey {
  installSlug: string;
  agentGroupId: string;
  sessionId: string;
}

/**
 * Not a union, for the same reason `DriverKind` is not: this tree composes
 * `['agent']` and must not enumerate roles it does not ship. An overlay that
 * composes auxiliary containers (a per-session proxy, say) brings its own role
 * names; the seam's rules key only on 'agent' — the one required role.
 */
export type ContainerRole = string;

export type MountClass = 'group-state' | 'install-surface' | 'identity-material' | 'allowlisted-extra';

export interface MountSpec {
  /**
   * Class = which pinning rule applies (and, later, what the sealed tier encrypts).
   * - 'group-state': state pinned to this group's subtrees (session channel, group
   *   folder, provider state — the path carries provider specifics; the seam is
   *   provider-agnostic). Usually rw; read-only views over group paths (composed
   *   instructions, per-group config) use this class with mode 'ro'.
   * - 'install-surface': shipped runtime surfaces from the release (runner source,
   *   skills, shared instructions). Pinned to an enumerated surfaceRoots allowlist —
   *   never a bare install-root prefix, since state roots may nest inside it; mode
   *   MUST be 'ro'.
   * - 'identity-material': provisioner-emitted certs and keys for an auxiliary
   *   container's leased identity. Pinned to the deployment's materialsRoot; mode
   *   MUST be 'ro'; NEVER mountable into the 'agent' role — this makes the
   *   no-credentials-in-agents invariant an admission-checkable rule.
   * - 'allowlisted-extra': arbitrary host paths vetted upstream by the mount allowlist.
   */
  class: MountClass;
  hostPath: string;
  containerPath: string;
  mode: 'rw' | 'ro';
  /** Lets a realization — by admission or by in-code checks — pin group-state to the group subtree. */
  groupScope: string;
}

export interface ContainerSpec {
  role: ContainerRole;
  /**
   * Decision 3: drivers never build and never resolve tags. Named `image`
   * rather than `imageDigest` because the spike pins by imported-tag identity
   * (k3s containerd has no registry to digest against); the *rule* the seam
   * enforces is unchanged — resolution happens before composition, never here.
   */
  image: string;
  /** Non-secret by contract; conformance asserts absence of secret-shaped keys. */
  env: Record<string, string>;
  /**
   * Env contributed by a registry-sourced lane (a model provider's container
   * config, the install's gateway) rather than composed literals. Same bytes
   * on the wire — the separation exists because provenance is what the secret
   * rules key on: these lanes are the sanctioned channel for credential-NAMED
   * configuration (a bearer placeholder the proxy overwrites, a stub the vault
   * swaps at egress), so `validateSpec` exempts the key-name check here — and
   * still refuses credential VALUES, from anyone. A typed field rather than a
   * marker value because a marker is claimable by any composer; a lane is
   * filled only by its call sites. Realizations emit `env` first, then this,
   * and on a key collision this lane wins — the ordering the old raw-argv
   * append guaranteed by Docker's last-wins rule, now stated as contract.
   */
  contributedEnv?: Record<string, string>;
  /**
   * PID 1 and its arguments. Split because not every runtime can express a
   * single argv the way `docker --entrypoint X image -c Y` can: `command`
   * maps to the container entrypoint, `args` to what follows it.
   */
  command?: string[];
  args?: string[];
  mounts: MountSpec[];
  /** Stamped onto the realized object in addition to the canonical key labels. */
  labels?: Record<string, string>;
  // No raw runtime flags here, ever: network topology is driver-private (the
  // Docker realization's `networkArgsFor`), and everything a gateway used to
  // append as raw `-e`/`-v` rides the typed lanes above, where admission can
  // see it. No raw security flags either. Rootfs policy (auxiliary roles: read-only; agent:
  // writable ephemeral scratch) is part of the named hardening posture, mapped per role by
  // each driver. Changing it means a new posture version, not a per-session knob.
}

export interface SessionResources {
  /**
   * Deliberately optional: today's Docker path sets no `--memory` unless the
   * operator opted in, so a required number here would silently introduce a
   * cap that OOM-kills workloads that run fine now. Undefined means unbounded
   * on both drivers.
   */
  memoryMb?: number;
  /** Docker `--cpus`, or the realization's cpu limit. Undefined means unbounded. */
  cpus?: string;
  /**
   * Docker `--pids-limit`. A realization with no per-session equivalent
   * reports this as a hardening reduction rather than faking it. See
   * `DriverCapabilities.unrealized`.
   */
  pidsLimit?: number;
  /** Docker `--shm-size`, or the realization's /dev/shm sizing. */
  shmSizeMb?: number;
}

export interface SessionSpec {
  key: SessionKey;
  /** Lineage labels (channel id, container instance id, ...). Drivers stamp these onto every runtime object. */
  labels: Record<string, string>;
  /** One session, one or more containers: ['agent'] in this tree; an overlay may compose auxiliary containers beside it. */
  containers: ContainerSpec[];
  /**
   * 'shared-private': the containers of this session reach the gateway and nothing
   * else. On Docker that is the egress-lockdown network machinery; other
   * realizations enforce it declaratively. `capabilities.networkPolicy` tells
   * the overlay which enforcement it got.
   */
  network: 'shared-private' | 'none';
  /** Named, versioned posture. Drivers map it; raw flags never cross the seam. */
  hardening: 'standard';
  resources: SessionResources;
  runtimeTier: 'container' | 'vm';
  /**
   * uid:gid the containers run as. Docker papers over an image/host uid mismatch
   * with `--user`; not every realization has such a default, so the identity
   * that must read 0600 material has to be explicit in the spec rather than
   * inherited from the image.
   */
  runAs?: { uid: number; gid: number };
  /** Grace before SIGKILL. Docker `stop -t`, or the realization's termination grace. */
  stopGraceSeconds: number;
}

export type SessionFailure =
  | { kind: 'spec-invalid'; retryable: false; detail: string }
  | { kind: 'denied-by-policy'; retryable: false; detail: string }
  | { kind: 'image-unavailable'; retryable: true }
  | { kind: 'runtime-unavailable'; retryable: true }
  | { kind: 'resources-exhausted'; retryable: true }
  | { kind: 'started-then-died'; retryable: false; exitCode?: number }
  | { kind: 'unknown'; retryable: false; opaqueRef: string };

export type SessionStatus =
  | { phase: 'preparing' }
  | { phase: 'ready' } // prepared, not started
  | { phase: 'running' }
  | { phase: 'stopped' }
  | { phase: 'failed'; failure: SessionFailure };

/**
 * Coarse liveness for discovery, deliberately distinct from `SessionStatus`:
 * that is the per-handle truth read; this is the one-shot classification a
 * list can vouch for without a per-handle round trip. 'starting' covers
 * prepared-not-started incarnations (a created container is not a corpse);
 * 'terminal' covers self-exited runtimes awaiting cleanup.
 */
export type SessionPhase = 'starting' | 'running' | 'terminal';

/**
 * One discovered session: the handle rebuilt from labels, plus the phase the
 * listing itself observed. `failure` rides along when the runtime recorded
 * one (a non-zero exit the list could still see).
 */
export interface SessionSnapshot {
  handle: SessionHandle;
  phase: SessionPhase;
  failure?: SessionFailure;
}

/**
 * Best-effort change notification from a driver's watch stream.
 *
 * Events are HINTS, never truth: they may drop, duplicate, coalesce, arrive
 * late, or reference keys the consumer has never seen. A consumer must treat
 * an event as "re-read truth via listSessions()/status() for this key" —
 * never as a state transition to act on directly. `kind` grades the hint:
 * 'terminal' (the driver observed an end), 'phase' (a liveness change),
 * 'hint' (something happened; go look).
 */
export interface SessionEvent {
  key: SessionKey;
  kind: 'terminal' | 'phase' | 'hint';
}

/** Subscription returned by `SessionDriver.watchSessions`. */
export interface SessionWatch {
  stop(): void;
}

/**
 * The argv a client shells to attach an interactive session to this runtime.
 *
 * The driver describes the invocation; it never performs it. Handing back argv
 * instead of a stream is what keeps an interactive attach honest: the terminal
 * belongs to the client's own stdio, so a caller that needs a real TTY gets one
 * from the process it spawns rather than from a pipe this layer would have to
 * emulate. It also keeps the driver seam free of process lifetime — nothing
 * here to supervise, cancel, or leak.
 *
 * Two variants because the caller, not the driver, knows whether a TTY is
 * appropriate: `argsTty` when stdin is a terminal, `argsPlain` when the attach
 * is piped or scripted. Allocating a TTY for a non-terminal stdin corrupts the
 * stream with control sequences, so this choice cannot be made from here.
 */
export interface SessionExecSpec {
  bin: string;
  argsTty: string[];
  argsPlain: string[];
}

export interface SessionHandle {
  key: SessionKey;
  /** Stable runtime name for logs and operator commands. */
  readonly name: string;
  start(): Promise<void>;
  status(): Promise<SessionStatus>;
  /**
   * Full teardown of everything this key allocated. The contract is that the
   * session ENDS and its resources get cleaned up; that today's
   * implementations block until the runtime object is actually gone is an
   * implementation behavior (it happens to serialize workspace single-writer
   * during termination), NOT a contract guarantee — callers must not rely on
   * blocking-until-gone.
   */
  stop(reason: string): Promise<void>;
  /**
   * The argv for attaching `command` interactively to this session. Pure
   * description — see `SessionExecSpec`. Valid only while the session is live;
   * a caller that races teardown gets the runtime's own error from the spawn,
   * not a lie from this layer.
   */
  execSpec(command: string[]): SessionExecSpec;
}

export interface DriverCapabilities {
  isolationTiers: ('container' | 'vm')[];
  admissionEnforced: boolean;
  networkPolicy: 'topology' | 'declarative';
  encryptedVolumes: boolean;
  /**
   * Spec fields this driver cannot realize, named honestly rather than faked.
   * A driver with no per-session pids cap lists 'pidsLimit' here.
   * Features gate on capabilities, never on driver identity.
   */
  unrealized: readonly (keyof SessionResources)[];
  /**
   * Whether the containers of a session share one network namespace. An egress
   * overlay reads this to decide the proxy URL it puts in the agent's env:
   * localhost when true, a resolvable name when the proxy is a separate host.
   */
  sharedNetworkNamespace: boolean;
  /**
   * Whether this driver realizes containers beside the agent. A driver that
   * does not MUST refuse specs carrying them — never validate-then-ignore:
   * silently dropping a composed container is semantic loss on a public
   * contract, not a degradation. Composition gates gateway-contributed
   * containers on this flag before such a spec is ever built, so the refusal
   * is a backstop, not the UX.
   */
  auxiliaryContainers: boolean;
  /**
   * Whether this runtime can rebuild per-group agent images in place
   * (`buildAgentGroupImage` shells `docker build` against the local daemon).
   * A driver whose node has no build daemon — images arrive pre-imported —
   * declares false, and BOTH call sites gate on this: `ncl groups restart
   * --rebuild` refuses in its payload, and the self-mod guard DENIES
   * install_packages at request time, so an admin is never asked to approve
   * a rebuild that cannot happen.
   */
  imageBuild: boolean;
}

export interface SessionDriver {
  /**
   * Identity, for logs and diagnostics only — never a branch. Deliberately not
   * a union: this tree ships one driver and enumerating kinds it cannot execute
   * would make every overlay's kind a change to this file. Selection resolves
   * kinds through the registry in `index.ts`.
   */
  readonly kind: string;
  capabilities(): DriverCapabilities;
  /** Fatal-at-startup reachability check. Agents cannot run without a runtime. */
  ensureReady?(): Promise<void>;
  /** Allocate everything, start nothing. Idempotent on key: an existing live session returns its handle. */
  prepare(spec: SessionSpec): Promise<SessionHandle>;
  /**
   * Discovery for adoption and reaping. Handles are reconstructed from
   * runtime-visible labels only. Each snapshot carries the phase the listing
   * observed, so a caller can tell adoptable sessions from corpses WITHOUT a
   * per-handle status() read: a self-exited runtime (an exited container with
   * no teardown in flight) is either excluded or returned with phase
   * 'terminal' — never dressed up as live.
   */
  listSessions(installSlug: string): Promise<SessionSnapshot[]>;
  /**
   * ONE driver-level subscription to session lifecycle changes for this
   * install — never a per-session watch process. Started lazily on the first
   * call; the driver owns reconnection with bounded backoff and never gives
   * up, because an unrecovered drop ends supervision for every session at
   * once. Events are best-effort hints (see `SessionEvent`). Drivers emit for
   * ALL observed terminal transitions with no intent filtering: stop-intent
   * suppression belongs to the session-events hub, not to drivers.
   */
  watchSessions(installSlug: string, onEvent: (event: SessionEvent) => void): SessionWatch;
  /**
   * Residue a stopped session could not clean up itself (a host that died
   * between stop and teardown). `stop()` remains full teardown for a live one.
   */
  reapResidue?(installSlug: string): Promise<void>;
}

/** Canonical label keys — the adoption contract. A handle must be rebuildable from these alone. */
export const LABELS = {
  install: 'nanoclaw-install',
  group: 'nanoclaw-group',
  session: 'nanoclaw-session',
  role: 'nanoclaw-role',
} as const;

/**
 * The group-folder label (D9). Deliberately NOT part of `LABELS`: adoption
 * rebuilds handles from the four canonical keys alone and must keep working
 * against sessions that predate this label. It exists for admission: the
 * `groups/<folder>` mount subtree is named by the folder, the folder is not
 * derivable from the group id (the mapping lives in the central DB, which
 * neither the in-code check nor a CEL policy can read), so the composer
 * carries it on the session for the policy to join `hostPath` prefixes
 * against. Composition stamps it into `SessionSpec.labels`; drivers realize
 * it VERBATIM or refuse — never projected, truncated or case-folded.
 */
export const GROUP_FOLDER_LABEL = 'nanoclaw-group-folder';

/**
 * A label VALUE every driver can realize VERBATIM: <=63 bytes of
 * `[A-Za-z0-9._-]`, alphanumeric at both ends (empty is legal). This is the
 * strictest label grammar any driver realizes values onto, adopted as the
 * seam-wide bound so a spec composed on one driver is not quietly
 * unrealizable on another. The charset is ASCII-only,
 * so for any value that passes, `length` counts bytes.
 *
 * Used to decide when a value may NOT be projected: `GROUP_FOLDER_LABEL` is
 * an admission join key and must be refused at composition, not capped by a
 * driver, when it fails this (see `composeSessionSpec`).
 */
export function labelValueLegal(value: string): boolean {
  return value.length <= 63 && /^(([A-Za-z0-9][-A-Za-z0-9_.]*)?[A-Za-z0-9])?$/.test(value);
}

export function labelsForKey(
  key: SessionKey,
  role: ContainerRole,
  extra: Record<string, string> = {},
): Record<string, string> {
  return {
    [LABELS.install]: key.installSlug,
    [LABELS.group]: key.agentGroupId,
    [LABELS.session]: key.sessionId,
    [LABELS.role]: role,
    ...extra,
  };
}

// ---------- failure constructors, shared by both drivers ----------

export type SessionFailureError = Error & SessionFailure;

export function specInvalid(detail: string): SessionFailureError {
  return Object.assign(new Error(`spec-invalid: ${detail}`), {
    kind: 'spec-invalid' as const,
    retryable: false as const,
    detail,
  });
}

export function deniedByPolicy(detail: string): SessionFailureError {
  return Object.assign(new Error(`denied-by-policy: ${detail}`), {
    kind: 'denied-by-policy' as const,
    retryable: false as const,
    detail,
  });
}

export function asFailureError(failure: SessionFailure): SessionFailureError {
  return Object.assign(new Error(`session realization failed: ${failure.kind}`), failure);
}

/**
 * Mount rules shared by every driver. A realization may ALSO enforce them
 * out-of-process (`capabilities.admissionEnforced`), but running them
 * host-side keeps external enforcement from being the only thing standing
 * between an agent and a private key.
 */
export interface MountPolicy {
  groupsRoot: string;
  dataRoot: string;
  surfaceRoots: string[];
  materialsRoot: string;
}

export function validateSpec(spec: SessionSpec, policy: MountPolicy, capabilities?: DriverCapabilities): void {
  // The tier check is against the caller's declared capabilities — features
  // gate on capabilities, never on driver identity. A caller without a
  // capabilities handle gets the floor every realization ships ('container'),
  // which keeps the two-argument form's behavior exactly.
  const tiers = capabilities?.isolationTiers ?? ['container'];
  if (!tiers.includes(spec.runtimeTier)) {
    throw specInvalid(`runtimeTier '${spec.runtimeTier}' not in driver isolation tiers [${tiers.join(', ')}]`);
  }
  if (spec.containers.filter((c) => c.role === 'agent').length !== 1) {
    // Exactly one, not at-least-one: the agent is the session's one required
    // role, and a second container claiming it would make every 'agent'-keyed
    // rule (identity-material exclusion, the realization's supervision) apply
    // to an ambiguous target.
    throw specInvalid('spec must carry exactly one agent container');
  }
  const pluginsRoot = stampedPluginsRoot(spec, policy);
  for (const container of spec.containers) {
    const seenTargets = new Set<string>();
    for (const mount of container.mounts) {
      if (!hostPathCanonical(mount.hostPath)) {
        // Every class rule below is a prefix check against a trusted root, and
        // a prefix check reads `materialsRoot/../outside` as inside — the
        // runtime then normalizes it OUTSIDE the root it was judged against.
        // Requiring the canonical absolute form makes the string these rules
        // judge the same path the runtime mounts. (A relative source would not
        // even be a bind: Docker reads it as a named volume.) Symlinks remain
        // beyond a lexical check — that is what `admissionEnforced`
        // realizations are for.
        throw deniedByPolicy(
          `mount ${mount.hostPath} must be a canonical absolute path (no '..', '.', '//', or trailing '/')`,
        );
      }
      if (seenTargets.has(mount.containerPath)) {
        // Two sources for one target would make the realized mount an ordering
        // artifact. Composition resolves collisions (contributed mounts win),
        // so a spec reaching a driver has exactly one source per target.
        throw specInvalid(`duplicate containerPath ${mount.containerPath} on ${container.role}`);
      }
      seenTargets.add(mount.containerPath);
      const required =
        classRequiredByPath(mount.hostPath, policy) ??
        (pluginsRoot && underRoot(mount.hostPath, pluginsRoot) ? 'install-surface' : null);
      if (required && mount.class !== required) {
        // Where a file lives decides what it IS, so the class is not the
        // composer's to choose for these roots. Without this the taxonomy is
        // only as strong as whoever assigns the class, and two of the four
        // classes carry safety properties that a demotion silently drops:
        // `allowlisted-extra` is permitted unconditionally, so relabelling a
        // session private key as one mounts it INTO THE AGENT — defeating the
        // no-credentials invariant outright — and relabelling the runner source
        // as one escapes the read-only rule on the code the agent executes.
        // Neither is exotic: both are a single word in a mount literal.
        throw deniedByPolicy(`mount ${mount.hostPath} must be classed ${required}, not ${mount.class}`);
      }
      if (mount.class === 'install-surface' && mount.mode !== 'ro') {
        throw deniedByPolicy(`install-surface mount ${mount.hostPath} must be ro`);
      }
      if (mount.class === 'identity-material' && (mount.mode !== 'ro' || container.role === 'agent')) {
        // The no-credentials invariant, as a checkable rule: identity materials
        // are ro-only and never enter the agent container.
        throw deniedByPolicy(`identity-material mount ${mount.hostPath} invalid on role ${container.role}`);
      }
      if (!mountAllowed(mount, spec, policy)) {
        throw deniedByPolicy(`mount ${mount.hostPath} violates class ${mount.class} scope ${mount.groupScope}`);
      }
    }
    for (const [key, value] of Object.entries(container.env)) {
      if (isSecretShaped(key, value)) {
        throw deniedByPolicy(`secret-shaped env '${key}' on ${container.role}`);
      }
    }
    for (const [key, value] of Object.entries(container.contributedEnv ?? {})) {
      // The sanctioned lane: credential-shaped NAMES are its purpose — a
      // provider registering `ANTHROPIC_AUTH_TOKEN=placeholder` for the proxy
      // to overwrite is the pattern working as intended, and the name check
      // alone denies every such install. Credential VALUES have no sanctioned
      // channel, from anyone: real material rides mounts by reference.
      if (looksLikeCredential(value)) {
        throw deniedByPolicy(`credential value in contributed env '${key}' on ${container.role}`);
      }
    }
  }
}

/**
 * The canonical absolute form the mount rules require: rooted, and free of
 * empty, '.' and '..' segments — so the string a prefix rule judges is the
 * path the runtime mounts, and a trusted root cannot be escaped lexically.
 */
function hostPathCanonical(hostPath: string): boolean {
  if (!hostPath.startsWith('/')) return false;
  const segments = hostPath.split('/').slice(1);
  return segments.every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

/**
 * The invariant is that no credential VALUE rides in the environment — not that
 * no key is ever named after one. So the rule measures both sides: a
 * credential-named key carrying a non-exempt value, OR a value that IS a
 * credential whatever its key is called. The name check alone measures the
 * wrong thing wherever the name is chosen by whoever is leaking:
 * `ANTHROPIC_API_KEY` is caught while the identical credential in
 * `ANTHROPIC_AUTH`, `GW_CRED` or `SESSION_BEARER` passes straight through.
 *
 * Two exemptions, neither able to admit a credential's bytes:
 *
 * - An absolute path. The mount classes pass material by reference: mount the
 *   file read-only, put its path in an env var.
 *   `PROXY_CLIENT_KEY=/run/session/session-key.pem` is that pattern
 *   working exactly as intended, and a key-name check alone rejects it —
 *   denying every session whose auxiliary containers need their own client
 *   key. A path is a pointer; the thing it points at is governed by
 *   the mount classes, where it is actually checkable.
 */
export function isSecretShaped(key: string, value: string): boolean {
  // A path is a pointer, never a credential, whatever the key is called.
  if (/^\/[^\s]*$/.test(value)) return false;
  return /(_KEY|_TOKEN|_SECRET|PASSWORD)$/i.test(key) || looksLikeCredential(value);
}

/**
 * Credential VALUES, recognised by issuer-assigned prefixes.
 *
 * Deliberately prefix-matching rather than entropy-scoring. Entropy
 * false-positives on legitimate opaque config — a base64 fingerprint, an image
 * digest, a UUID-ish id — and a false positive here does not warn, it denies
 * every session at once, fail-closed. These prefixes are issuer-assigned and
 * cannot plausibly appear in ordinary configuration. The list is a floor, not
 * a guarantee: it catches the credentials people actually paste, and the
 * key-name check above still covers well-named keys carrying anything else.
 */
export function looksLikeCredential(value: string): boolean {
  return (
    /^sk-[A-Za-z0-9_-]{20,}$/.test(value) || // Anthropic / OpenAI
    /^(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}$/.test(value) || // GitHub
    /^github_pat_[A-Za-z0-9_]{20,}$/.test(value) ||
    /^xox[baprs]-[A-Za-z0-9-]{10,}$/.test(value) || // Slack
    /^AKIA[0-9A-Z]{16}$/.test(value) || // AWS access key id
    /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value) || // JWT
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(value) // a key pasted inline
  );
}

/**
 * The class a path is not allowed to disagree with.
 *
 * Only the two roots whose classes carry a safety property are pinned this way.
 * `group-state` and `allowlisted-extra` stay a composition choice, because
 * `allowlisted-extra` legitimately covers operator-configured read-write mounts
 * and forcing those read-only would break the mount-allowlist feature. The rule
 * is not "everything is derived" — it is "a class that grants something cannot
 * be claimed by a path that has not earned it".
 */
export function classRequiredByPath(hostPath: string, policy: MountPolicy): MountClass | null {
  if (underRoot(hostPath, policy.materialsRoot)) return 'identity-material';
  if (policy.surfaceRoots.some((root) => underRoot(hostPath, root))) return 'install-surface';
  return null;
}

/**
 * `groups/<folder>/plugins` — the one install surface that does not live under
 * an install root.
 *
 * Whole-plugin stamping copies a validated plugin's whole tree into the group
 * folder and mounts it read-only, because what lands there is code the agent
 * EXECUTES (skills, stdio MCP servers) and the plugin contract sends writes to
 * `plugin-data/` instead. That is the `install-surface` property exactly — and
 * `install-surface` is the only class whose read-only rule is enforced rather
 * than chosen, which is the point: classed `allowlisted-extra` it would be
 * permitted unconditionally, and the read-only pin on executed code would be
 * one word in a mount literal away from gone.
 *
 * It cannot be a `surfaceRoots` entry, though, and the reason is structural
 * rather than incidental: every surfaceRoot is also a REQUIRED class
 * (`classRequiredByPath`), and every root that contains this path also contains
 * the group's read-write state mounts — the group folder itself, container.json,
 * the composed instructions. Listing `groupsRoot` would force all of those to
 * `install-surface` too and deny every session. Listing the exact per-group path
 * is impossible: a `MountPolicy` is install-wide and knows no group.
 *
 * So it is pinned here instead, joined through `GROUP_FOLDER_LABEL` — the same
 * verbatim label admission uses to pin `groups/<folder>` hostPath prefixes,
 * doing precisely the job it was added for. A spec that carries no folder label
 * gets no plugins root, and a `groups/<folder>/plugins` mount on it is judged by
 * the ordinary class rules.
 */
export function stampedPluginsRoot(spec: SessionSpec, policy: MountPolicy): string | null {
  const folder = spec.labels[GROUP_FOLDER_LABEL];
  if (!folder || !labelValueLegal(folder)) return null;
  return `${policy.groupsRoot}/${folder}/plugins`;
}

function mountAllowed(mount: MountSpec, spec: SessionSpec, policy: MountPolicy): boolean {
  switch (mount.class) {
    case 'allowlisted-extra':
      // Vetted upstream by the mount-allowlist feature.
      return true;
    case 'install-surface': {
      if (policy.surfaceRoots.some((root) => underRoot(mount.hostPath, root))) return true;
      const pluginsRoot = stampedPluginsRoot(spec, policy);
      return pluginsRoot !== null && underRoot(mount.hostPath, pluginsRoot);
    }
    case 'identity-material':
      return underRoot(mount.hostPath, policy.materialsRoot);
    case 'group-state': {
      if (mount.groupScope !== spec.key.agentGroupId) return false;
      if (underRoot(mount.hostPath, `${policy.dataRoot}/v2-sessions/${mount.groupScope}`)) return true;
      if (underRoot(mount.hostPath, policy.groupsRoot)) {
        // The groups root holds EVERY group's folder, so "under groupsRoot"
        // alone would grant a session any group's state — `groupScope` cannot
        // arbitrate, being stamped by the same composer whose mounts are being
        // judged. The folder label can: it is admission's join key, carried
        // verbatim, and it pins this session to its own subtree.
        const folder = spec.labels[GROUP_FOLDER_LABEL];
        if (!folder || !labelValueLegal(folder)) return false;
        return underRoot(mount.hostPath, `${policy.groupsRoot}/${folder}`);
      }
      return false;
    }
    default:
      return false;
  }
}

function underRoot(hostPath: string, root: string): boolean {
  return hostPath === root || hostPath.startsWith(`${root}/`);
}
