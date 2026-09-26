/**
 * Formats, rate-limits, and delivers operational errors to the configured
 * messaging group through the host's channel delivery adapter.
 *
 * Reports raised before channels are up (the startup crash-loop backoff runs
 * before any adapter exists) are queued and sent once the adapter is ready.
 * Repeats of the same key inside the quiet window are counted, not sent; the
 * next report for that key says how many were suppressed.
 */
import { getMessagingGroup } from '../../db/messaging-groups.js';
import type { ChannelDeliveryAdapter } from '../../delivery.js';
import { readEnvFile } from '../../env.js';
import { log } from '../../log.js';
import type { OperationalError } from '../../operational-errors.js';

const DEFAULT_QUIET_MINUTES = 60;
const MAX_PENDING = 20;
const MAX_DETAIL_CHARS = 300;

export interface ErrorReportConfig {
  messagingGroupId: string;
  threadId: string | null;
  quietMs: number;
}

export function readErrorReportConfig(): ErrorReportConfig | null {
  const env = readEnvFile(['ERROR_REPORTS_MESSAGING_GROUP', 'ERROR_REPORTS_THREAD_ID', 'ERROR_REPORTS_QUIET_MINUTES']);
  const messagingGroupId = env.ERROR_REPORTS_MESSAGING_GROUP?.trim();
  if (!messagingGroupId) return null;
  const minutes = Number(env.ERROR_REPORTS_QUIET_MINUTES);
  return {
    messagingGroupId,
    threadId: env.ERROR_REPORTS_THREAD_ID?.trim() || null,
    quietMs: (Number.isFinite(minutes) && minutes >= 0 ? minutes : DEFAULT_QUIET_MINUTES) * 60_000,
  };
}

export function formatReport(error: OperationalError, suppressed: number): string {
  const lines = [`⚠️ NanoClaw: ${error.message}`, `${error.kind} · ${error.timestamp}`];
  for (const [key, value] of Object.entries(error.details ?? {})) {
    if (value === undefined || value === null) continue;
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    lines.push(`${key}: ${text.length > MAX_DETAIL_CHARS ? `${text.slice(0, MAX_DETAIL_CHARS)}…` : text}`);
  }
  if (suppressed > 0) lines.push(`(${suppressed} similar report(s) suppressed since the last one)`);
  return lines.join('\n');
}

export interface ErrorReporter {
  report(error: OperationalError): Promise<void>;
  attach(adapter: ChannelDeliveryAdapter): Promise<void>;
}

export function createErrorReporter(config: ErrorReportConfig): ErrorReporter {
  const lastSent = new Map<string, { at: number; suppressed: number }>();
  const pending: string[] = [];
  let adapter: ChannelDeliveryAdapter | null = null;
  let draining: Promise<void> | null = null;

  async function drain(target: ChannelDeliveryAdapter): Promise<void> {
    /* eslint-disable no-catch-all/no-catch-all -- an error reporter must never raise errors of its own */
    try {
      const mg = await getMessagingGroup(config.messagingGroupId);
      if (!mg) {
        log.warn('Error reports: messaging group not found, dropping reports', {
          messagingGroupId: config.messagingGroupId,
          dropped: pending.length,
        });
        pending.length = 0;
        return;
      }
      while (pending.length > 0) {
        const text = pending.shift() as string;
        try {
          await target.deliver(
            mg.channel_type,
            mg.platform_id,
            config.threadId,
            'chat-sdk',
            JSON.stringify({ text }),
            undefined,
            mg.instance,
          );
        } catch (err) {
          log.warn('Error reports: delivery failed', { messagingGroupId: mg.id, err });
        }
      }
    } catch (err) {
      log.warn('Error reports: could not resolve the destination', { err });
    }
    /* eslint-enable no-catch-all/no-catch-all */
  }

  function flush(): Promise<void> {
    if (!adapter) return Promise.resolve();
    if (!draining) {
      draining = drain(adapter).finally(() => {
        draining = null;
        if (pending.length > 0) void flush();
      });
    }
    return draining;
  }

  return {
    report(error) {
      const now = Date.now();
      const prev = lastSent.get(error.key);
      if (prev && now - prev.at < config.quietMs) {
        prev.suppressed += 1;
        return Promise.resolve();
      }
      lastSent.set(error.key, { at: now, suppressed: 0 });
      pending.push(formatReport(error, prev?.suppressed ?? 0));
      if (pending.length > MAX_PENDING) {
        pending.shift();
        log.warn('Error reports: queue full, dropped the oldest report');
      }
      return flush();
    },
    attach(next) {
      adapter = next;
      return flush();
    },
  };
}
