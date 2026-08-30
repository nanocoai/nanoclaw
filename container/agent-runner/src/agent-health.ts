import fs from 'node:fs';

import { gatewayUnsignedFetch, type MailboxFetch } from './modules/s3-mailbox/gateway-fetch.js';

const HEARTBEAT_PATH = '/workspace/.heartbeat';
const READY_MS = 6_000;
export const ABSOLUTE_CEILING_MS = 30 * 60 * 1_000;
export const CLAIM_STUCK_MS = 60 * 1_000;
const INTERNAL_TIMEOUT_MS = 8_000;

interface Claim { messageId: string; statusChanged: string }
interface ContainerState { currentTool: string | null; toolDeclaredTimeoutMs: number | null }

export type HealthDecision =
  | { action: 'ok' }
  | { action: 'kill-ceiling' }
  | { action: 'kill-claim'; messageId: string };

export function heartbeatFresh(now = Date.now(), heartbeatPath = HEARTBEAT_PATH): boolean {
  try {
    return now - fs.statSync(heartbeatPath).mtimeMs < READY_MS;
  } catch {
    return false;
  }
}

/**
 * Readiness asks "has this agent come up?", NOT "is it working right now".
 *
 * `heartbeat-init` seeds the file with the container start time as CONTENT and
 * backdates its mtime to epoch 0 — that zero is the sentinel for "the agent has
 * never beaten". The runner then touches the file as it streams a turn
 * (poll-loop.ts, via touchHeartbeat), so a NON-zero mtime is proof the agent
 * process reached its loop at least once.
 *
 * Freshness is the wrong readiness test because the agent touches the heartbeat
 * only while a turn is in flight. An idle agent — the normal steady state
 * between messages — goes stale within READY_MS and reports NotReady forever,
 * which is exactly what an answered-then-idle session looked like: the reply
 * had already been delivered while the pod sat at 2/3.
 *
 * A wedged (as opposed to idle) agent is the liveness probe's job: it runs the
 * expensive mailbox check on a 60s period and owns the kill ceilings. Readiness
 * stays local and cheap so it can run every 2s.
 */
export function agentStarted(heartbeatPath = HEARTBEAT_PATH): boolean {
  try {
    return fs.statSync(heartbeatPath).mtimeMs > 0;
  } catch {
    return false;
  }
}

export function decideLiveness(args: {
  now: number;
  heartbeatMtimeMs: number;
  containerStartedAtMs?: number;
  containerState: ContainerState | null;
  claims: Claim[];
}): HealthDecision {
  const bashMs = args.containerState?.currentTool === 'Bash' ? args.containerState.toolDeclaredTimeoutMs : null;
  const effectiveHeartbeat = args.heartbeatMtimeMs || args.containerStartedAtMs || 0;
  if (effectiveHeartbeat && args.now - effectiveHeartbeat > Math.max(ABSOLUTE_CEILING_MS, bashMs ?? 0)) {
    return { action: 'kill-ceiling' };
  }
  const tolerance = Math.max(CLAIM_STUCK_MS, bashMs ?? 0);
  for (const claim of args.claims) {
    const claimedAt = Date.parse(claim.statusChanged);
    if (!Number.isFinite(claimedAt) || args.now - claimedAt <= tolerance) continue;
    if (args.heartbeatMtimeMs > claimedAt) continue;
    return { action: 'kill-claim', messageId: claim.messageId };
  }
  return { action: 'ok' };
}

export async function livenessHealthy(
  now = Date.now(),
  heartbeatPath = HEARTBEAT_PATH,
  fetchFactory: (capability: string) => MailboxFetch = (capability) => {
    const transport = gatewayUnsignedFetch(process.env.HTTPS_PROXY);
    transport.bindCapability?.(capability);
    return transport;
  },
): Promise<boolean> {
  try {
    return await withTimeout(async () => {
      let heartbeatMtimeMs = 0;
      let containerStartedAtMs: number | undefined;
      try {
        heartbeatMtimeMs = fs.statSync(heartbeatPath).mtimeMs;
        const started = Number(fs.readFileSync(heartbeatPath, 'utf8').trim());
        if (Number.isFinite(started) && started > 0) containerStartedAtMs = started;
      } catch {
        // Missing/read-failed heartbeat uses the same spawn-time fallback below.
      }
      const context = parseContext(await Bun.file(
        process.env.NANOCLAW_SESSION_CONTEXT || '/app/.nanoclaw-session.json',
      ).json());
      const transport = fetchFactory(context.capability);
      const { state, claims } = await readLivenessState(transport, context);
      return decideLiveness({ now, heartbeatMtimeMs, containerStartedAtMs, containerState: state, claims }).action === 'ok';
    }, INTERNAL_TIMEOUT_MS);
  } catch {
    // Probe infrastructure must never become a destructive liveness decision.
    return true;
  }
}

interface Context { agentGroupId: string; sessionId: string; capability: string }

function parseContext(value: unknown): Context {
  const row = value as { agentGroupId?: unknown; sessionId?: unknown; mailbox?: { capability?: unknown } };
  if (typeof row?.agentGroupId !== 'string' || typeof row.sessionId !== 'string' ||
      typeof row.mailbox?.capability !== 'string' || !/^[a-f0-9]{64}$/.test(row.mailbox.capability)) {
    throw new Error('invalid session context');
  }
  return { agentGroupId: row.agentGroupId, sessionId: row.sessionId, capability: row.mailbox.capability };
}

async function readLivenessState(
  transport: MailboxFetch,
  context: Context,
): Promise<{ state: ContainerState | null; claims: Claim[] }> {
  const endpoint = required('NANOCLAW_MAILBOX_S3_ENDPOINT').replace(/\/+$/, '');
  const bucket = required('NANOCLAW_MAILBOX_S3_BUCKET');
  const prefix = process.env.NANOCLAW_MAILBOX_S3_PREFIX?.replace(/^\/+|\/+$/g, '') ?? '';
  const base = [prefix, 'v2', 'agent-groups', segment(context.agentGroupId), 'sessions', segment(context.sessionId),
    'capabilities', context.capability, 'outbound'].filter(Boolean).join('/');
  const bucketUrl = `${endpoint}/${encodeURIComponent(bucket)}`;
  const container = await readEnvelope(transport, `${bucketUrl}/${objectPath(`${base}/container/container.json`)}`, 'container', true);
  const query = new URLSearchParams({ 'list-type': '2', prefix: `${base}/acknowledgements/` });
  const listed = await transport.fetch(`${bucketUrl}?${query}`);
  if (!listed.ok) throw new Error(`mailbox list failed: ${listed.status}`);
  const xml = await listed.text();
  const keys = [...xml.matchAll(/<Key>([\s\S]*?)<\/Key>/g)].map((match) => decodeXml(match[1] ?? ''));
  const envelopes = await Promise.all(keys.map((key) =>
    readEnvelope(transport, `${bucketUrl}/${objectPath(key)}`, 'processingAck', false)));
  const claims = envelopes
    .map((envelope) => envelope as { messageId?: unknown; status?: unknown; statusChanged?: unknown } | null)
    .filter((row): row is { messageId: string; status: 'processing'; statusChanged: string } =>
      row?.status === 'processing' && typeof row.messageId === 'string' && typeof row.statusChanged === 'string')
    .map(({ messageId, statusChanged }) => ({ messageId, statusChanged }));
  const row = container as { currentTool?: unknown; toolDeclaredTimeoutMs?: unknown } | null;
  const state = row && (row.currentTool === null || typeof row.currentTool === 'string') &&
    (row.toolDeclaredTimeoutMs === null || typeof row.toolDeclaredTimeoutMs === 'number')
    ? { currentTool: row.currentTool, toolDeclaredTimeoutMs: row.toolDeclaredTimeoutMs }
    : null;
  return { state, claims };
}

async function readEnvelope(
  transport: MailboxFetch,
  url: string,
  expectedType: string,
  optional: boolean,
): Promise<unknown | null> {
  const response = await transport.fetch(url);
  if (optional && response.status === 404) return null;
  if (!response.ok) throw new Error(`mailbox read failed: ${response.status}`);
  const envelope = await response.json() as { modelVersion?: unknown; recordType?: unknown; record?: unknown };
  if (envelope.modelVersion !== 1 || envelope.recordType !== expectedType) throw new Error('invalid mailbox envelope');
  return envelope.record;
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`missing ${name}`);
  return value;
}

function segment(value: string): string {
  return encodeURIComponent(value).replace(/\./g, '%2E');
}

function objectPath(key: string): string {
  return key.split('/').map(encodeURIComponent).join('/');
}

function decodeXml(value: string): string {
  return value.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

async function withTimeout<T>(action: () => Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      action(),
      new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error('health timeout')), timeoutMs); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

if (import.meta.main) {
  const mode = process.argv[2];
  const healthy = mode === 'readiness' ? agentStarted() : mode === 'liveness' ? await livenessHealthy() : false;
  process.exit(healthy ? 0 : 1);
}
