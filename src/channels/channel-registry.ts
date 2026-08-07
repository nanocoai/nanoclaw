/**
 * Channel adapter registry.
 *
 * Channels self-register on import. The host calls initChannelAdapters() at startup
 * to instantiate and set up all registered adapters.
 */
import type { ChannelAdapter, ChannelDefaults, ChannelRegistration, ChannelSetup, OutboundFile } from './adapter.js';
import type { ChannelDeliveryAdapter } from '../delivery.js';
import { log } from '../log.js';

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
    ): Promise<void> {
      const adapter = getChannelAdapterExact(instance ?? channelType);
      await adapter?.setTyping?.(platformId, threadId);
    },
  };
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
