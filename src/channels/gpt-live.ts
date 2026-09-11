/**
 * GPT-Live channel — OpenAI's full-duplex voice model (`gpt-live-1`) as the
 * mouth and ears of a call, with the NanoClaw agent as the brain.
 *
 * Shape: native adapter (no Chat SDK bridge). A *voice line* is one
 * conversation: its platform id is `gpt-live:<line id>`, where the line id is
 * the first 12 hex characters of the link token's SHA-256 — the router
 * namespaces ids for this channel that way, and the token itself never
 * reaches the database, the logs or the agent's messages. The messaging group
 * and its wiring are created once (by the skill) and every call on that link
 * lands in the same agent session — the agent remembers the last call. There
 * are no threads. One call is active per line at a time.
 *
 * The live session is created in *client delegation* mode. Whenever the
 * voice model decides a turn needs facts, memory or tools it emits a
 * delegation event; the adapter turns the transcript since the last
 * delegation into an inbound message, and the agent's reply comes back as
 * spoken commentary.
 *
 * Transports:
 *  - WebRTC (browser), this version: the call page at
 *    `/webhook/gpt-live/call?t=<token>` posts its SDP offer to `…/sdp`; the
 *    host creates the session, attaches the sideband, and returns the answer.
 *  - SIP (phone), next: OpenAI posts `realtime.call.incoming` to `…/sip`.
 *
 * Both end in the same place: a server-side *sideband* WebSocket attached
 * to the session (`/v1/live/sessions/{id}/attach`, bearer auth — the URL the
 * OpenAI SDK builds), where transcripts and delegations arrive and results
 * are pushed. Node's built-in WebSocket client and fetch are used; no SDK.
 *
 * Credentials: `OPENAI_API_KEY` is read from `.env` on the host, like other
 * channel adapters read their tokens. The agent container never sees it.
 * The link token gates the HTTP routes: a request without a known `t` gets
 * a 403 before any session (and any billing) starts. The token is never
 * logged or stored; everything NanoClaw keeps is keyed by the line id.
 */
import { createHash } from 'node:crypto';
import type http from 'node:http';

import type { ChannelAdapter, ChannelDefaults, ChannelSetup, InboundMessage, OutboundMessage } from './adapter.js';
import { registerChannelAdapter } from './channel-registry.js';
import { callPageHtml } from './gpt-live-call-page.js';
import { resolveOpenAiKey } from './gpt-live-keychain.js';
import { attachSideband, type SidebandSocket } from './gpt-live-sideband.js';
import { resolveWiredAgent, sessionConfig, type VoiceAgent } from './gpt-live-prompt.js';
import {
  GptLiveSession,
  type DelegationRequest,
  type LiveClientEvent,
  type LiveServerEvent,
} from './gpt-live-session.js';
import { readEnvFile } from '../env.js';
import { log } from '../log.js';
import { registerWebhookHandler } from '../webhook-server.js';

export const CHANNEL_TYPE = 'gpt-live';
const DEFAULT_API_BASE = 'https://api.openai.com/v1';
const DEFAULT_WS_BASE = 'wss://api.openai.com/v1';
/** Silent "still working" notes to the voice model go out at most this often while a reply is pending. */
export const THINK_INTERVAL_MS = 20_000;

/**
 * A voice line is DM-shaped: everything the voice model delegates is for the
 * agent (pattern '.'), there are no threads and no platform mention concept.
 * The link token is the credential — whoever holds the link is the line's
 * user — so the DM context is 'public'. Group context is unused; declared
 * strict so a stray group-shaped row never opens the line.
 */
const GPT_LIVE_DEFAULTS: ChannelDefaults = {
  dm: { engageMode: 'pattern', engagePattern: '.', threads: false, unknownSenderPolicy: 'public' },
  group: { engageMode: 'pattern', engagePattern: '.', threads: false, unknownSenderPolicy: 'strict' },
  mentions: 'dm-only',
};

export interface GptLiveConfig {
  apiKey: string;
  /** Origin the caller's browser reaches the host at (for the call link). */
  publicUrl: string;
  /** Voice for new sessions. */
  voice: string;
  /** Link tokens accepted on the HTTP routes; each is one voice line. */
  linkTokens: string[];
  /** Name used when no agent is wired to the line yet. */
  fallbackAgentName: string;
  /** REST base; overridable for tests. */
  apiBase?: string;
  /** WebSocket base; overridable for tests. */
  wsBase?: string;
  /** Looks up the agent wired to a line; defaults to the central-DB lookup. */
  resolveAgent?: (platformId: string) => Promise<VoiceAgent | null>;
  /** Observability tap: every sideband server event, before the state machine sees it. */
  onSidebandEvent?: (sessionId: string, event: LiveServerEvent) => void;
  /** Clock, overridable for tests. */
  now?: () => number;
}

export type { SidebandSocket } from './gpt-live-sideband.js';

/** Thrown to the HTTP route when a newer call on the same line replaced this one mid-attach. */
export class CallReplacedError extends Error {
  constructor(readonly platformId: string) {
    super('gpt-live: a newer call replaced this one');
    this.name = 'CallReplacedError';
  }
}

interface LiveCall {
  platformId: string;
  session: GptLiveSession;
  socket: SidebandSocket | null;
  /** When the last thinking note went out (config clock). */
  lastThinkAt: number;
}

/**
 * The line id for a link token: `gpt-live:` + the first 12 hex characters of
 * the token's SHA-256. It is the platform id, the sender id and what the logs
 * show; the token itself stays in the adapter's allow-list and the call link.
 */
export function lineIdForToken(token: string): string {
  return `${CHANNEL_TYPE}:${createHash('sha256').update(token).digest('hex').slice(0, 12)}`;
}

export function createGptLiveAdapter(config: GptLiveConfig): ChannelAdapter {
  const apiBase = (config.apiBase ?? DEFAULT_API_BASE).replace(/\/+$/, '');
  const wsBase = (config.wsBase ?? DEFAULT_WS_BASE).replace(/\/+$/, '');
  const tokens = new Set(config.linkTokens.map((t) => t.trim()).filter(Boolean));
  const resolveAgent = config.resolveAgent ?? ((platformId: string) => resolveWiredAgent(platformId));
  const now = config.now ?? (() => Date.now());
  /** Active call per voice line, keyed by platform id. */
  const lines = new Map<string, LiveCall>();
  let setup: ChannelSetup | null = null;
  let connected = false;

  const sendEvent = (call: LiveCall, event: LiveClientEvent): void => {
    if (!call.socket) {
      log.warn('gpt-live: no sideband for this call; dropping client event', {
        sessionId: call.session.sessionId,
        type: event.type,
      });
      return;
    }
    call.socket.send(JSON.stringify(event));
  };

  const onDelegation = (req: DelegationRequest): void => {
    const call = [...lines.values()].find((c) => c.session.sessionId === req.sessionId);
    if (!call || !setup) return;
    const message: InboundMessage = {
      id: `${req.sessionId}:${req.delegationId}`,
      kind: 'chat',
      content: {
        text: req.transcript,
        sender: 'Voice line',
        senderId: call.platformId,
        gptLive: {
          sessionId: req.sessionId,
          delegationId: req.delegationId,
          offsetMs: req.offsetMs,
          supersedes: req.supersedes,
        },
      },
      timestamp: new Date().toISOString(),
      isMention: true,
      isGroup: false,
    };
    // Tell the voice model work has started; the reply lands through deliver(). Later typing
    // ticks are throttled against this note (setTyping below).
    call.lastThinkAt = now();
    call.session.think('Working on it.');
    void Promise.resolve(setup.onInbound(call.platformId, null, message)).catch((err) => {
      log.error('gpt-live: onInbound threw', { platformId: call.platformId, err });
    });
  };

  const endCall = (call: LiveCall, reason: string): void => {
    if (lines.get(call.platformId) === call) lines.delete(call.platformId);
    const socket = call.socket;
    call.socket = null;
    socket?.close();
    log.info('gpt-live: call ended', { platformId: call.platformId, sessionId: call.session.sessionId, reason });
  };

  /** Attach the server-side sideband and pump its events into the call's state machine. */
  const connectSideband = (call: LiveCall): Promise<SidebandSocket> =>
    attachSideband({
      wsBase,
      apiKey: config.apiKey,
      sessionId: call.session.sessionId,
      onEvent: (event) => {
        config.onSidebandEvent?.(call.session.sessionId, event);
        call.session.handle(event);
      },
      onClose: (code, reason) => {
        // The server closing the sideband means the session is over for us.
        if (!call.session.isClosed()) call.session.handle({ type: 'session.closed', code, reason });
      },
    });

  /**
   * Open a call on a line. Newest wins: a call already on the line is ended
   * first. Two requests can overlap while the sideband attaches, so once the
   * socket is open the call checks it still owns the line; if a newer call
   * took it meanwhile, this one closes the session it just attached to (so
   * it stops billing) and its request is refused with a CallReplacedError.
   */
  const openCall = async (token: string, sessionId: string): Promise<LiveCall> => {
    const platformId = lineIdForToken(token);
    const previous = lines.get(platformId);
    if (previous) {
      previous.session.close();
      endCall(previous, 'replaced by a new call');
    }
    const call: LiveCall = {
      platformId,
      socket: null,
      session: null as unknown as GptLiveSession,
      lastThinkAt: 0,
    };
    call.session = new GptLiveSession(sessionId, {
      send: (event) => sendEvent(call, event),
      onDelegation,
      onClosed: (reason) => endCall(call, reason),
    });
    lines.set(platformId, call);
    let socket: SidebandSocket;
    try {
      socket = await connectSideband(call);
    } catch (err) {
      endCall(call, 'sideband attach failed');
      throw err;
    }
    if (lines.get(platformId) !== call) {
      socket.send(JSON.stringify({ type: 'session.close' }));
      socket.close();
      log.info('gpt-live: call refused, a newer call took the line while attaching', { platformId, sessionId });
      throw new CallReplacedError(platformId);
    }
    call.socket = socket;
    return call;
  };

  /** Create a WebRTC session from the browser's SDP offer; returns the SDP answer. */
  const createWebRtcSession = async (
    offer: string,
    agent: VoiceAgent,
  ): Promise<{ sessionId: string; answer: string }> => {
    const res = await fetch(`${apiBase}/live/sessions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ session: sessionConfig(agent, config.voice), transport: { type: 'webrtc', sdp: offer } }),
    });
    if (!res.ok) throw new Error(`gpt-live: session create failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
    const body = (await res.json()) as { session?: { id?: string }; transport?: { sdp?: string } };
    if (!body.session?.id || !body.transport?.sdp) throw new Error('gpt-live: session create returned no id/sdp');
    return { sessionId: body.session.id, answer: body.transport.sdp };
  };

  const readBody = async (req: http.IncomingMessage): Promise<string> => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks).toString('utf8');
  };

  const reply = (
    res: http.ServerResponse,
    status: number,
    body: string,
    headers: Record<string, string> = {},
  ): void => {
    res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
    res.end(body);
  };

  /** HTTP routes under /webhook/gpt-live/… on the shared webhook server. */
  const handleHttp = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const route = url.pathname.replace(/^\/webhook\/gpt-live\/?/, '').replace(/\/+$/, '');
    const token = url.searchParams.get('t') ?? '';
    try {
      if (req.method === 'GET' && route === 'call') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(callPageHtml());
        return;
      }
      if (route === 'sdp' || route === 'hangup') {
        if (req.method !== 'POST') return reply(res, 405, 'POST only');
        if (!tokens.has(token)) return reply(res, 403, 'Unknown call link');
      }
      if (route === 'sdp') {
        const offer = await readBody(req);
        if (!offer.trim().startsWith('v=')) return reply(res, 400, 'Body must be an SDP offer');
        const platformId = lineIdForToken(token);
        const agent = (await resolveAgent(platformId)) ?? { name: config.fallbackAgentName };
        const { sessionId, answer } = await createWebRtcSession(offer, agent);
        log.info('gpt-live: session created', { platformId, sessionId, agent: agent.name });
        try {
          await openCall(token, sessionId);
        } catch (err) {
          if (err instanceof CallReplacedError) return reply(res, 409, 'A newer call replaced this one');
          throw err;
        }
        reply(res, 200, answer, { 'Content-Type': 'application/sdp', 'X-GPT-Live-Session': sessionId });
        return;
      }
      if (route === 'hangup') {
        const call = lines.get(lineIdForToken(token));
        if (call) {
          call.session.close();
          endCall(call, 'hangup');
        }
        reply(res, 204, '');
        return;
      }
      if (req.method === 'POST' && route === 'sip') {
        // Next phase: realtime.call.incoming → accept (session config) or reject (603).
        return reply(res, 501, 'SIP calls are not wired yet');
      }
      reply(res, 404, 'Not found');
    } catch (err) {
      // The shared webhook server has no other way to answer the browser.
      log.error('gpt-live: http route failed', { route, err });
      if (!res.headersSent) reply(res, 500, 'gpt-live error');
      else res.end();
    }
  };

  return {
    name: CHANNEL_TYPE,
    channelType: CHANNEL_TYPE,
    supportsThreads: false,
    defaults: GPT_LIVE_DEFAULTS,

    async setup(cfg: ChannelSetup): Promise<void> {
      setup = cfg;
      registerWebhookHandler(CHANNEL_TYPE, handleHttp);
      connected = true;
      log.info('gpt-live: ready', {
        callUrl: `${config.publicUrl}/webhook/gpt-live/call?t=<link token>`,
        lines: tokens.size,
        voice: config.voice,
      });
    },

    async teardown(): Promise<void> {
      for (const call of [...lines.values()]) {
        call.session.close();
        endCall(call, 'teardown');
      }
      connected = false;
    },

    isConnected(): boolean {
      return connected;
    },

    async deliver(platformId: string, _threadId: string | null, message: OutboundMessage): Promise<string | undefined> {
      const call = lines.get(platformId);
      if (!call) {
        log.warn('gpt-live: no active call on this line; dropping reply', { platformId });
        return undefined;
      }
      const content = message.content as { text?: unknown } | string;
      const text = typeof content === 'string' ? content : typeof content?.text === 'string' ? content.text : '';
      if (!text.trim()) return undefined;
      const ids = call.session.speak(text);
      return ids.at(-1);
    },

    async setTyping(platformId: string, _threadId: string | null, status?: string): Promise<void> {
      // The host re-fires typing every few seconds for as long as the agent works. The voice
      // model needs one quiet note now and then, not a drumbeat: at most one per
      // THINK_INTERVAL_MS while a reply is pending, none once the reply went out.
      const call = lines.get(platformId);
      if (!call || call.session.pendingDelegations().length === 0) return;
      const t = now();
      if (t - call.lastThinkAt < THINK_INTERVAL_MS) return;
      call.lastThinkAt = t;
      call.session.think(status?.trim() || 'Still working on it.');
    },
  };
}

registerChannelAdapter(CHANNEL_TYPE, {
  factory: () => {
    const env = readEnvFile([
      'OPENAI_API_KEY',
      'GPT_LIVE_KEYCHAIN_SERVICE',
      'GPT_LIVE_KEYCHAIN_ACCOUNT',
      'GPT_LIVE_PUBLIC_URL',
      'GPT_LIVE_VOICE',
      'GPT_LIVE_LINK_TOKEN',
      'GPT_LIVE_AGENT_NAME',
    ]);
    const key = resolveOpenAiKey(env);
    if (!key) return null;
    if (!env.GPT_LIVE_LINK_TOKEN) {
      log.warn('gpt-live: GPT_LIVE_LINK_TOKEN is not set; the channel stays offline');
      return null;
    }
    log.info('gpt-live: OpenAI key loaded', { source: key.source });
    return createGptLiveAdapter({
      apiKey: key.key,
      publicUrl: (env.GPT_LIVE_PUBLIC_URL || 'http://localhost:3000').replace(/\/+$/, ''),
      voice: env.GPT_LIVE_VOICE || 'marin',
      linkTokens: env.GPT_LIVE_LINK_TOKEN.split(','),
      fallbackAgentName: env.GPT_LIVE_AGENT_NAME || 'the assistant',
    });
  },
  defaults: GPT_LIVE_DEFAULTS,
});
