/**
 * Channel adapter registry.
 *
 * Channels self-register on import. The host calls initChannelAdapters() at startup
 * to instantiate and set up all registered adapters.
 */
import type { ChannelAdapter, ChannelDefaults, ChannelRegistration, ChannelSetup, OutboundFile } from './adapter.js';
import type { ChannelDeliveryAdapter } from '../delivery.js';
import { log } from '../log.js';

/** Adapter instance registry key shape: a webhook route segment and state-namespace key, so URL-safe only. */
export const INSTANCE_KEY_RE = /^[A-Za-z0-9._-]+$/;

/** Webhook routing path shape (the part after `/webhook/`): one or two URL-safe segments. */
export const WEBHOOK_ROUTING_PATH_RE = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)?$/;

// ---------------------------------------------------------------------------
// Adapter instance specs
// ---------------------------------------------------------------------------

/**
 * One adapter instance, described independently of where its credentials
 * live. An adapter module builds specs in env mode (from `SLACK_INSTANCES` /
 * `TEAMS_INSTANCES`); an operator surface builds them from stored connection
 * rows and hands them to registerChannelInstance. Credentials are NOT part of
 * the spec: the channel's instance factory resolves them through the channel
 * credential provider (credential-provider.ts) when the instance starts.
 */
export interface ChannelInstanceSpec {
  /**
   * Registry key of the instance — also the outbound routing key stored on
   * messaging_groups.instance and the adapter's state namespace. URL-safe
   * (INSTANCE_KEY_RE). A spec whose instance equals its channelType
   * describes the platform's default instance.
   */
  instance: string;
  channelType: 'slack' | 'teams';
  /**
   * The external scope this instance belongs to: a Slack team id (`T…`) or
   * a Teams tenant id. When set, the adapter accepts only envelopes from
   * that scope and acks-and-drops every other one. Unset ⇒ no pin, which is
   * what env-mode instances get unless the operator configured one.
   */
  externalScope?: string;
  /** `socket` needs an app-level token (Slack only); `webhook` needs the shared listener. */
  transport: 'webhook' | 'socket';
  /**
   * Full request path on the webhook listener, e.g. `/webhook/slack/acme-hq`.
   * Defaults to defaultWebhookPath(spec): `/webhook/<channelType>/<instance>`
   * for a named instance, `/webhook/<channelType>` for the default one.
   * Ignored by socket transport.
   */
  webhookPath?: string;
}

export const WEBHOOK_PATH_PREFIX = '/webhook/';

/** The listener path an instance gets when its spec names none. */
export function defaultWebhookPath(spec: Pick<ChannelInstanceSpec, 'channelType' | 'instance'>): string {
  return spec.instance === spec.channelType
    ? `${WEBHOOK_PATH_PREFIX}${spec.channelType}`
    : `${WEBHOOK_PATH_PREFIX}${spec.channelType}/${spec.instance}`;
}

/**
 * The routing path (after `/webhook/`) the bridge registers for a spec —
 * `slack` for the default instance, `slack/acme-hq` for a connection, or
 * whatever one- or two-segment path the spec names. Throws on any other
 * shape so a bad connection row fails at registration, not at first webhook.
 */
export function webhookRoutingPath(
  spec: Pick<ChannelInstanceSpec, 'channelType' | 'instance' | 'webhookPath'>,
): string {
  const full = spec.webhookPath ?? defaultWebhookPath(spec);
  if (!full.startsWith(WEBHOOK_PATH_PREFIX)) {
    throw new Error(
      `channel instance '${spec.instance}': webhookPath must start with '${WEBHOOK_PATH_PREFIX}' (got ${JSON.stringify(full)})`,
    );
  }
  const routing = full.slice(WEBHOOK_PATH_PREFIX.length);
  if (!WEBHOOK_ROUTING_PATH_RE.test(routing)) {
    throw new Error(
      `channel instance '${spec.instance}': webhookPath must be '/webhook/<segment>' or ` +
        `'/webhook/<segment>/<segment>' with URL-safe segments (got ${JSON.stringify(full)})`,
    );
  }
  return routing;
}

/** Throws with an actionable message when a spec cannot describe a startable instance. */
export function validateChannelInstanceSpec(spec: ChannelInstanceSpec): void {
  if (typeof spec.instance !== 'string' || !INSTANCE_KEY_RE.test(spec.instance)) {
    throw new Error(
      `channel instance key ${JSON.stringify(spec.instance)} must be URL-safe: non-empty, only letters, digits, '.', '_' or '-'`,
    );
  }
  if (typeof spec.channelType !== 'string' || !INSTANCE_KEY_RE.test(spec.channelType)) {
    throw new Error(
      `channel instance '${spec.instance}': channelType ${JSON.stringify(spec.channelType)} is not a channel type`,
    );
  }
  if (spec.transport !== 'webhook' && spec.transport !== 'socket') {
    throw new Error(
      `channel instance '${spec.instance}': transport must be 'webhook' or 'socket' (got ${JSON.stringify(spec.transport)})`,
    );
  }
  if (spec.externalScope !== undefined && (typeof spec.externalScope !== 'string' || spec.externalScope === '')) {
    throw new Error(`channel instance '${spec.instance}': externalScope must be a non-empty string when set`);
  }
  webhookRoutingPath(spec);
}

/**
 * Builds the registry entry for one spec of a channel type. Registered by the
 * adapter module on import (`registerChannelInstanceFactory('slack', …)`), so
 * an operator surface can turn a stored connection into a live instance
 * without knowing how that platform's bridge is constructed. The returned
 * registration's `factory` runs at instance start and is where credentials
 * are resolved.
 */
export type ChannelInstanceFactory = (spec: ChannelInstanceSpec) => ChannelRegistration;

const instanceFactories = new Map<string, ChannelInstanceFactory>();
const instanceSpecs = new Map<string, ChannelInstanceSpec>();

export function registerChannelInstanceFactory(channelType: string, factory: ChannelInstanceFactory): void {
  if (instanceFactories.has(channelType)) {
    log.warn('Channel instance factory overwritten', { channelType });
  }
  instanceFactories.set(channelType, factory);
}

export function getChannelInstanceFactory(channelType: string): ChannelInstanceFactory | undefined {
  return instanceFactories.get(channelType);
}

/**
 * Register (or re-register) an adapter instance from its spec under
 * `spec.instance`. Validates the spec, builds the registration through the
 * channel type's instance factory, and remembers the spec for
 * getChannelInstanceSpec. Start it with startChannelAdapter(spec.instance);
 * a re-registration of a live instance takes effect at its next start
 * (stopChannelAdapter → startChannelAdapter).
 */
export function registerChannelInstance(spec: ChannelInstanceSpec): void {
  validateChannelInstanceSpec(spec);
  const factory = instanceFactories.get(spec.channelType);
  if (!factory) {
    throw new Error(
      `registerChannelInstance: no instance factory for channel type '${spec.channelType}' — ` +
        `is its adapter installed and imported by the channel barrel?`,
    );
  }
  const frozen: ChannelInstanceSpec = { ...spec };
  registerChannelAdapter(frozen.instance, factory(frozen));
  instanceSpecs.set(frozen.instance, frozen);
}

/** The spec an instance was registered from (a copy), or undefined for registrations made without one. */
export function getChannelInstanceSpec(key: string): ChannelInstanceSpec | undefined {
  const spec = instanceSpecs.get(key);
  return spec ? { ...spec } : undefined;
}

export function listChannelInstanceSpecs(): ChannelInstanceSpec[] {
  return [...instanceSpecs.values()].map((spec) => ({ ...spec }));
}

const SETUP_RETRY_DELAYS_MS = [2000, 5000, 10000];

/** Duck-type check — adapters that throw an Error with `name === 'NetworkError'`
 * (Chat SDK's `@chat-adapter/shared.NetworkError` and similar) get a retry on
 * setup. Avoids depending on `@chat-adapter/shared` at trunk level. */
function isNetworkError(err: unknown): err is Error {
  return err instanceof Error && err.name === 'NetworkError';
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const registry = new Map<string, ChannelRegistration>();
const activeAdapters = new Map<string, ChannelAdapter>();

/** Register a channel adapter factory. Called by channel modules on import. */
export function registerChannelAdapter(name: string, registration: ChannelRegistration): void {
  registry.set(name, registration);
}

/** Get a live adapter by its EXACT registry key (instance name; default
 *  instances are keyed by channelType itself). No channelType fallback —
 *  callers that address a specific instance (outbound delivery, typing)
 *  must never be rerouted through a sibling instance: that would send
 *  through the wrong bot identity with the wrong token. A missing key
 *  means the owning adapter is offline; callers apply their normal
 *  offline-adapter handling. */
export function getChannelAdapterExact(key: string): ChannelAdapter | undefined {
  return activeAdapters.get(key);
}

/** Get a live adapter by instance name, falling back to any adapter of the
 *  given channel type. The fallback exists ONLY for channelType-only callers
 *  (user-id prefix resolution and cold DMs in user-dm.ts, approval delivery
 *  in channel-approval.ts, the router's thread-policy probe when an event
 *  carries no instance) — they must still resolve when every instance of a
 *  platform is named. First registered wins (Map insertion order,
 *  deterministic). Default instances are keyed by channelType itself, so
 *  single-instance installs always hit the exact-key path. Instance-addressed
 *  dispatch (delivery, typing) must use getChannelAdapterExact instead. */
export function getChannelAdapter(key: string): ChannelAdapter | undefined {
  const exact = activeAdapters.get(key);
  if (exact) return exact;
  for (const [registryKey, adapter] of activeAdapters) {
    if (adapter.channelType === key) {
      log.warn('Channel adapter fallback: requested key resolved through a differently-keyed instance', {
        requested: key,
        resolvedKey: registryKey,
      });
      return adapter;
    }
  }
  return undefined;
}

/** Thrown by the delivery bridge when the exact adapter for an outbound
 *  message is not registered (credentials missing so the factory returned
 *  null, setup failed, or a named instance is offline). Deliberately a throw
 *  rather than an `undefined` return: `undefined` is also what a successful
 *  adapter with no platform message id resolves to, and a normal return makes
 *  `drainSession` mark the row delivered even though nothing was sent (#2995).
 *  Throwing routes the message into the delivery retry path, where it ends as
 *  `status='failed'` if the adapter never comes back. */
export class MissingChannelAdapterError extends Error {
  constructor(
    readonly channelType: string,
    readonly instance?: string,
  ) {
    super(
      `No adapter registered for '${instance ?? channelType}' — message enters the delivery retry path. ` +
        `Check the startup log for why this channel's adapter did not start.`,
    );
    this.name = 'MissingChannelAdapterError';
  }
}

/**
 * Build the host's outbound delivery bridge: dispatches delivery-poll and
 * typing traffic into the adapter registry. Resolution is EXACT-key only —
 * `instance ?? channelType`. For default-instance messaging_groups rows the
 * stored instance IS the channelType, which matches default-registered
 * adapters, so single-instance behavior is unchanged. A named instance whose
 * adapter is offline gets the normal offline-adapter handling
 * (MissingChannelAdapterError → the delivery retry path) — never a
 * cross-identity send through a sibling bot of the same platform.
 */
export function createChannelDeliveryAdapter(): ChannelDeliveryAdapter {
  return {
    async deliver(
      channelType: string,
      platformId: string,
      threadId: string | null,
      kind: string,
      content: string,
      files?: OutboundFile[],
      instance?: string,
    ): Promise<string | undefined> {
      const adapter = getChannelAdapterExact(instance ?? channelType);
      if (!adapter) {
        throw new MissingChannelAdapterError(channelType, instance);
      }
      return adapter.deliver(platformId, threadId, { kind, content: JSON.parse(content), files });
    },
    async setTyping(
      channelType: string,
      platformId: string,
      threadId: string | null,
      instance?: string,
      status?: string,
      statusKind?: 'auto' | 'agent',
    ): Promise<void> {
      const adapter = getChannelAdapterExact(instance ?? channelType);
      await adapter?.setTyping?.(platformId, threadId, status, statusKind);
    },
  };
}

/**
 * Registry passthrough for the optional per-thread title API. Exact-key
 * resolution only (`mg.instance ?? mg.channel_type` — same discipline as
 * delivery/typing dispatch: a named instance must never re-title through a
 * sibling bot). Missing adapter or missing capability is a silent no-op —
 * titles are decoration, never worth a delivery failure.
 */
export async function setThreadTitle(key: string, platformId: string, threadId: string, title: string): Promise<void> {
  const adapter = getChannelAdapterExact(key);
  await adapter?.setThreadTitle?.(platformId, threadId, title);
}

/**
 * Registry passthrough for agent-view suggested prompts. Exact-key
 * resolution; missing adapter/capability is a silent no-op — prompts are
 * onboarding decoration, never worth a failure.
 */
export async function setSuggestedPrompts(
  key: string,
  platformId: string,
  prompts: Array<{ title: string; message: string }>,
  title?: string,
): Promise<void> {
  const adapter = getChannelAdapterExact(key);
  await adapter?.setSuggestedPrompts?.(platformId, prompts, title);
}

/**
 * Behavior-faithful fallback for adapters with no `defaults` declaration
 * (stale skill-installed copies, unknown channel types). Values reproduce
 * what trunk did before declarations existed, so a trunk update alone
 * changes nothing for undeclared adapters:
 *  - dm: pattern '.' (every DM message engages), router auto-create policy
 *    'request_approval' (src/router.ts auto-create branch).
 *  - group: mention-sticky (what the card-approval flow stamped on group
 *    channels), same 'request_approval' policy.
 *  - threads follow the raw capability in BOTH contexts — a NULL (inherit)
 *    wiring resolved through this fallback behaves exactly like today's
 *    supportsThreads-derived routing.
 *  - mentions 'platform': never blocks a mention wiring at creation time.
 */
export function fallbackChannelDefaults(supportsThreads: boolean): ChannelDefaults {
  return {
    dm: {
      engageMode: 'pattern',
      engagePattern: '.',
      threads: supportsThreads,
      unknownSenderPolicy: 'request_approval',
    },
    group: {
      engageMode: 'mention-sticky',
      threads: supportsThreads,
      unknownSenderPolicy: 'request_approval',
    },
    mentions: 'platform',
  };
}

/**
 * Resolve a channel's declared wiring defaults. Never returns undefined.
 *
 * `key` follows the same discipline as getChannelAdapter: mg.instance ??
 * mg.channel_type. Tiers, first hit wins:
 *  1. live adapter, instance-exact — lets an instance carry env-computed
 *     declarations (e.g. WhatsApp shared-number mode);
 *  2. live adapter of that channelType (mirrors getChannelAdapter's scan);
 *  3. registration entry under the key — covers offline scripts and
 *     factories that returned null for missing creds;
 *  4. registration entry under the channelType — resolved from the live
 *     adapter found in tiers 1-2 (a stale adapter copy without a declaration
 *     whose registration has one), else from the optional `channelType`
 *     hint, which callers holding a named-instance mg row should pass so a
 *     dead instance still resolves its platform's declaration;
 *  5. fallbackChannelDefaults on the live adapter's capability (false when
 *     no adapter is live — conservative, reachable only from manual creation
 *     surfaces since the router never sees events for unregistered channels).
 */
export function getChannelDefaults(key: string, channelType?: string): ChannelDefaults {
  const { live, decl } = lookupDeclaredDefaults(key, channelType);
  return decl ?? fallbackChannelDefaults(live?.supportsThreads ?? false);
}

/**
 * True iff getChannelDefaults would resolve from an actual declaration (tiers
 * 1-4) rather than fallbackChannelDefaults. Manual creation surfaces (`ncl`)
 * gate declaration-derived defaults on this: for stale (undeclared) adapters
 * they keep the legacy static schema defaults — engage_mode 'mention',
 * unknown_sender_policy 'strict' — so a trunk update alone changes nothing.
 * The faithful fallback exists for the ROUTER's auto-create/runtime paths,
 * whose historical behavior it reproduces; it is not what `ncl` did.
 */
export function hasDeclaredChannelDefaults(key: string, channelType?: string): boolean {
  return lookupDeclaredDefaults(key, channelType).decl !== undefined;
}

/** Shared tiers 1-4 of getChannelDefaults (see its doc); `decl` undefined
 *  means only tier 5 (fallback) remains. */
function lookupDeclaredDefaults(
  key: string,
  channelType?: string,
): { live: ChannelAdapter | undefined; decl: ChannelDefaults | undefined } {
  let live = activeAdapters.get(key);
  if (!live) {
    for (const adapter of activeAdapters.values()) {
      if (adapter.channelType === key) {
        live = adapter;
        break;
      }
    }
  }
  if (live?.defaults) return { live, decl: live.defaults };

  const typeKey = live?.channelType ?? channelType;
  const registered =
    registry.get(key)?.defaults ?? (typeKey !== undefined ? registry.get(typeKey)?.defaults : undefined);
  return { live, decl: registered };
}

/** Get all active adapters. */
export function getActiveAdapters(): ChannelAdapter[] {
  return [...activeAdapters.values()];
}

/** Get all registered channel names. */
export function getRegisteredChannelNames(): string[] {
  return [...registry.keys()];
}

/** Get container config for a channel (used by container-runner for additional mounts/env). */
export function getChannelContainerConfig(name: string): ChannelRegistration['containerConfig'] {
  return registry.get(name)?.containerConfig;
}

/**
 * Instantiate and set up all registered channel adapters.
 * Skips adapters that return null (missing credentials).
 */
export async function initChannelAdapters(setupFn: (adapter: ChannelAdapter) => ChannelSetup): Promise<void> {
  hotStartSetupFn = setupFn;
  for (const [name, registration] of registry) {
    try {
      const adapter = await registration.factory();
      if (!adapter) {
        log.warn('Channel credentials missing, skipping', { channel: name });
        continue;
      }

      const setup = setupFn(adapter);
      // Transient network failures during adapter init (e.g. Telegram deleteWebhook
      // hitting a DNS hiccup at boot) would otherwise leave the channel permanently
      // dead until manual restart. Retry only on NetworkError so misconfigs (bad
      // tokens, etc.) still fail fast.
      let attempt = 0;
      while (true) {
        try {
          await adapter.setup(setup);
          break;
        } catch (err) {
          if (isNetworkError(err) && attempt < SETUP_RETRY_DELAYS_MS.length) {
            const delay = SETUP_RETRY_DELAYS_MS[attempt]!;
            log.warn('Channel adapter setup failed with network error, retrying', {
              channel: name,
              attempt: attempt + 1,
              delayMs: delay,
              err: err.message,
            });
            await sleep(delay);
            attempt += 1;
            continue;
          }
          throw err;
        }
      }
      // Adapters key by instance (default instance = channelType), so N
      // instances of one platform coexist. Duplicate keys warn instead of
      // throwing — boot stays resilient, matching the historical silent
      // last-write-wins, but now visibly.
      const key = adapter.instance ?? adapter.channelType;
      if (activeAdapters.has(key)) {
        log.warn('Duplicate adapter instance key — overwriting previous adapter', { key, channel: name });
      }
      activeAdapters.set(key, adapter);
      log.info('Channel adapter started', { channel: name, type: adapter.channelType, instance: key });
    } catch (err) {
      log.error('Failed to start channel adapter', { channel: name, err });
    }
  }
}

/** Tear down all active adapters. */
export async function teardownChannelAdapters(): Promise<void> {
  for (const [name, adapter] of activeAdapters) {
    try {
      await adapter.teardown();
      log.info('Channel adapter stopped', { channel: name });
    } catch (err) {
      log.error('Failed to stop channel adapter', { channel: name, err });
    }
  }
  activeAdapters.clear();
}

/**
 * slack-agent-flow seam — hot-start ONE registered adapter after boot.
 * Captures the host's setupFn from initChannelAdapters and replays the same
 * four boot steps (factory → setupFn(adapter) → setup with NetworkError retry
 * → activeAdapters.set) for a single registry entry, so a freshly provisioned
 * instance (e.g. `slack-<name>`) comes online without a host restart.
 * Installed by the slack-agent-flow skill; adapter-hot-start.test.ts pins it.
 */
let hotStartSetupFn: ((adapter: ChannelAdapter) => ChannelSetup) | null = null;

export async function startChannelAdapter(key: string): Promise<'started' | 'already-active' | 'no-credentials'> {
  if (activeAdapters.has(key)) return 'already-active';
  const registration = registry.get(key);
  if (!registration) throw new Error(`startChannelAdapter: no registration for '${key}'`);
  if (!hotStartSetupFn) throw new Error('startChannelAdapter: initChannelAdapters has not run');
  const adapter = await registration.factory();
  if (!adapter) return 'no-credentials';
  const setup = hotStartSetupFn(adapter);
  let attempt = 0;
  while (true) {
    try {
      await adapter.setup(setup);
      break;
    } catch (err) {
      if (isNetworkError(err) && attempt < SETUP_RETRY_DELAYS_MS.length) {
        const delay = SETUP_RETRY_DELAYS_MS[attempt]!;
        log.warn('Hot-start adapter setup failed with network error, retrying', {
          channel: key,
          attempt: attempt + 1,
          delayMs: delay,
          err: err.message,
        });
        await sleep(delay);
        attempt += 1;
        continue;
      }
      throw err;
    }
  }
  const activeKey = adapter.instance ?? adapter.channelType;
  if (activeAdapters.has(activeKey)) {
    log.warn('Duplicate adapter instance key — overwriting previous adapter', { key: activeKey, channel: key });
  }
  activeAdapters.set(activeKey, adapter);
  log.info('Channel adapter hot-started', { channel: key, type: adapter.channelType, instance: activeKey });
  return 'started';
}

/**
 * Stop ONE active adapter by its exact registry key — the inverse of
 * startChannelAdapter. The registration (and spec) stays, so the instance
 * can be started again; unregisterChannelAdapter removes it for good.
 * The active entry is dropped before teardown so delivery and typing stop
 * resolving the instance while its transport (socket, webhook route) is
 * released; a teardown failure still leaves it inactive, and is rethrown.
 */
export async function stopChannelAdapter(key: string): Promise<'stopped' | 'not-active'> {
  const adapter = activeAdapters.get(key);
  if (!adapter) return 'not-active';
  activeAdapters.delete(key);
  try {
    await adapter.teardown();
  } catch (err) {
    log.error('Failed to stop channel adapter', { channel: key, err });
    throw err;
  }
  log.info('Channel adapter stopped', { channel: key, type: adapter.channelType });
  return 'stopped';
}

/**
 * Remove a registration (and its spec) so nothing can start it again.
 * Refuses while the instance is active — stopChannelAdapter first.
 * Returns false when no registration existed.
 */
export function unregisterChannelAdapter(key: string): boolean {
  if (activeAdapters.has(key)) {
    throw new Error(`unregisterChannelAdapter: '${key}' is active — stopChannelAdapter first`);
  }
  instanceSpecs.delete(key);
  return registry.delete(key);
}
