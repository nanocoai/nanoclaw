/**
 * Delivery fallback module.
 *
 * Opt-in. The operator names a preferred channel type and a fallback
 * destination. When a send on the preferred channel throws, the same message is
 * retried once on the fallback destination, and approver delivery prefers
 * approvers on other channels until the preferred channel has been quiet for a
 * cooldown. Without configuration nothing is registered.
 *
 *   DELIVERY_FALLBACK_FROM=<channel-type>                 e.g. slack
 *   DELIVERY_FALLBACK_TO=<channel-type>:<platform-id>     e.g. telegram:123456
 *   DELIVERY_FALLBACK_COOLDOWN_MS=<ms>                    optional, default 60000
 */
import { registerDeliveryAdapterWrapper, type ChannelDeliveryAdapter } from '../../delivery.js';
import { readEnvFile } from '../../env.js';
import { log } from '../../log.js';
import { registerApprovalDeliveryOrder } from '../approvals/primitive.js';

export interface DeliveryFallbackConfig {
  /** Channel type whose failed sends are retried elsewhere. */
  from: string;
  /** Where the retry goes. */
  to: { channelType: string; platformId: string };
  /** How long the preferred channel counts as degraded after a failure. */
  cooldownMs: number;
}

const DEFAULT_COOLDOWN_MS = 60_000;
const KEYS = ['DELIVERY_FALLBACK_FROM', 'DELIVERY_FALLBACK_TO', 'DELIVERY_FALLBACK_COOLDOWN_MS'];

/** Returns null when the fallback is not configured or the config is unusable. */
export function resolveDeliveryFallbackConfig(
  env: Record<string, string | undefined> = { ...readEnvFile(KEYS), ...pick(process.env) },
): DeliveryFallbackConfig | null {
  const from = env.DELIVERY_FALLBACK_FROM?.trim();
  const to = env.DELIVERY_FALLBACK_TO?.trim();
  if (!from && !to) return null;
  const idx = to ? to.indexOf(':') : -1;
  const channelType = idx > 0 ? to!.slice(0, idx) : '';
  const platformId = idx > 0 ? to!.slice(idx + 1) : '';
  if (!from || !channelType || !platformId) {
    log.warn('Delivery fallback ignored: set both DELIVERY_FALLBACK_FROM and DELIVERY_FALLBACK_TO=<type>:<id>');
    return null;
  }
  if (channelType === from) {
    log.warn('Delivery fallback ignored: the fallback channel must differ from the preferred one', { from });
    return null;
  }
  const cooldown = Number(env.DELIVERY_FALLBACK_COOLDOWN_MS);
  return {
    from,
    to: { channelType, platformId },
    cooldownMs:
      Number.isFinite(cooldown) && cooldown >= 0 && env.DELIVERY_FALLBACK_COOLDOWN_MS ? cooldown : DEFAULT_COOLDOWN_MS,
  };
}

function pick(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(KEYS.flatMap((key) => (env[key] === undefined ? [] : [[key, env[key]]])));
}

export function createDeliveryFallback(config: DeliveryFallbackConfig, now: () => number = Date.now) {
  let degradedUntil = 0;
  const isDegraded = (): boolean => now() < degradedUntil;

  const wrap = (inner: ChannelDeliveryAdapter): ChannelDeliveryAdapter => ({
    ...inner,
    async deliver(channelType, platformId, threadId, kind, content, files, instance) {
      if (channelType !== config.from) {
        return inner.deliver(channelType, platformId, threadId, kind, content, files, instance);
      }
      try {
        const id = await inner.deliver(channelType, platformId, threadId, kind, content, files, instance);
        degradedUntil = 0;
        return id;
      } catch (err) {
        degradedUntil = now() + config.cooldownMs;
        log.warn('Delivery failed on preferred channel, retrying on fallback', {
          from: config.from,
          to: config.to.channelType,
          err,
        });
        try {
          return await inner.deliver(config.to.channelType, config.to.platformId, null, kind, content, files);
        } catch (fallbackErr) {
          log.warn('Fallback delivery failed too', { to: config.to.channelType, err: fallbackErr });
          throw err;
        }
      }
    },
  });

  /** Approvers on the preferred channel go last while it is degraded. */
  const order = (approvers: string[]): string[] => {
    if (!isDegraded()) return approvers;
    const onPreferred = (userId: string): boolean => userId.startsWith(`${config.from}:`);
    return [...approvers.filter((id) => !onPreferred(id)), ...approvers.filter(onPreferred)];
  };

  return { wrap, order, isDegraded };
}

export function registerDeliveryFallback(
  config: DeliveryFallbackConfig | null = resolveDeliveryFallbackConfig(),
): void {
  if (!config) return;
  const fallback = createDeliveryFallback(config);
  registerDeliveryAdapterWrapper(fallback.wrap);
  registerApprovalDeliveryOrder(fallback.order);
}
