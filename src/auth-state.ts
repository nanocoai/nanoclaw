/**
 * Shared runtime auth posture for the Anthropic credential path.
 *
 * The Claude subscription login (OAuth, CLAUDE_CODE_OAUTH_TOKEN) is PRIMARY;
 * the raw API key (ANTHROPIC_API_KEY) is a hot standby. The credential proxy
 * watches upstream responses and reports failures here:
 *   - eviction  : 401 on the OAuth token-exchange  -> failover, no self-heal
 *   - usage gate: 429 sustained for >5 min          -> failover, auto-recovers
 * On failover the effective mode flips to 'api-key'. container-runner reads
 * getEffectiveMode() when launching each agent, so the NEXT container picks up
 * the change. A usage-gate failover re-probes OAuth after a cooldown and
 * switches back once a real OAuth response succeeds.
 *
 * The proxy and container-runner share one process (index.ts), so this
 * module-level singleton is the shared state. Alerts go out via the unified
 * send_alert.py (email + Signal + macOS), deduped there.
 */
import { execFile } from 'child_process';

import { readEnvFile } from './env.js';
import { logger } from './logger.js';

export type AuthMode = 'api-key' | 'oauth';

const SEND_ALERT = '/Users/Shared/bd-brain-sync/scripts/send_alert.py';
const GATE_WINDOW_MS = 5 * 60 * 1000; // sustained 429 before we fail over
const RECOVERY_MS = 30 * 60 * 1000; // re-probe OAuth this long after a gate

interface State {
  hasOAuth: boolean;
  hasApiKey: boolean;
  mode: AuthMode; // effective mode right now
  failedOver: boolean; // on api-key because OAuth failed (vs. by config)
  probing: boolean; // tentatively back on oauth, awaiting a healthy response
  reason: string | null;
  gateFirstSeen: number | null; // first 429 of the current streak
  recoveryTimer: ReturnType<typeof setTimeout> | null;
}

function init(): State {
  const env = readEnvFile(['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY']);
  const hasOAuth = !!env.CLAUDE_CODE_OAUTH_TOKEN;
  const hasApiKey = !!env.ANTHROPIC_API_KEY;
  // Subscription (OAuth) is primary. Fall back to api-key only if OAuth absent.
  const mode: AuthMode = hasOAuth ? 'oauth' : 'api-key';
  logger.info({ mode, hasOAuth, hasApiKey }, 'Auth posture initialized');
  return {
    hasOAuth,
    hasApiKey,
    mode,
    failedOver: false,
    probing: false,
    reason: null,
    gateFirstSeen: null,
    recoveryTimer: null,
  };
}

const state: State = init();

export function getEffectiveMode(): AuthMode {
  return state.mode;
}

export function authStatus(): Readonly<State> {
  return state;
}

function alert(key: string, title: string, body: string): void {
  execFile(
    'python3',
    [SEND_ALERT, '--key', key, '--title', title, '--body', body],
    { timeout: 60000 },
    (err) => {
      if (err) logger.warn({ err: err.message, key }, 'auth alert send failed');
    },
  );
}

function failover(
  reason: string,
  alertKey: string,
  title: string,
  body: string,
): void {
  if (!state.hasApiKey) {
    logger.error({ reason }, 'OAuth failed and no API-key standby available');
    alert(`${alertKey}_nostandby`, `${title} (no API-key standby!)`, body);
    return;
  }
  const alreadyOnStandby = state.mode === 'api-key' && state.failedOver;
  state.mode = 'api-key';
  state.failedOver = true;
  state.probing = false;
  state.reason = reason;
  state.gateFirstSeen = null;
  logger.error({ reason }, 'Auth failed over to API-key standby');
  if (!alreadyOnStandby) alert(alertKey, title, body);
  if (reason === 'oauth-usage-gate') scheduleRecovery();
}

/** 401 on the OAuth token exchange: the subscription login was evicted. */
export function noteEviction(detail: string): void {
  failover(
    'oauth-evicted',
    'auth_evicted',
    'Andy: subscription login evicted',
    `OAuth login rejected (401${detail ? `: ${detail}` : ''}). Failed over ` +
      `to the paid API key. This will NOT self-heal — regenerate the token ` +
      `with \`claude setup-token\` and update CLAUDE_CODE_OAUTH_TOKEN in ` +
      `/Users/Shared/nanoclaw/.env, then restart nanoclaw.`,
  );
}

/** 429 on the subscription path: fail over only if it persists past the window. */
export function noteUsageGate(): void {
  if (state.mode === 'api-key' && !state.probing) return;
  const now = Date.now();
  if (state.gateFirstSeen === null) {
    state.gateFirstSeen = now;
    logger.warn('Subscription usage-gated (429); watching 5-min window');
    return;
  }
  if (now - state.gateFirstSeen >= GATE_WINDOW_MS) {
    failover(
      'oauth-usage-gate',
      'auth_usage_gate',
      'Andy: subscription usage limit hit',
      `The Claude subscription has been usage-gated (429) for over 5 min. ` +
        `Failed over to the paid API key. It will re-probe the subscription ` +
        `and switch back automatically once the window resets.`,
    );
  }
}

/** A successful response on the OAuth path: healthy. Confirms recovery. */
export function noteHealthy(): void {
  state.gateFirstSeen = null;
  if (state.failedOver && state.probing) {
    state.failedOver = false;
    state.probing = false;
    state.reason = null;
    logger.info('OAuth subscription recovered; switched back from standby');
    alert(
      'auth_recovered',
      'Andy: subscription restored',
      'The Claude subscription login is healthy again — switched back from ' +
        'the API-key standby.',
    );
  }
}

function scheduleRecovery(): void {
  if (state.recoveryTimer) return;
  state.recoveryTimer = setTimeout(() => {
    state.recoveryTimer = null;
    if (!state.failedOver) return;
    // Tentatively flip back to OAuth so the next container probes it. If it is
    // still gated, noteUsageGate() re-fails-over (and re-arms this timer). If
    // it succeeds, noteHealthy() confirms recovery and sends the all-clear.
    logger.info('Re-probing OAuth subscription after gate cooldown');
    state.mode = 'oauth';
    state.probing = true;
    state.gateFirstSeen = null;
  }, RECOVERY_MS);
}
