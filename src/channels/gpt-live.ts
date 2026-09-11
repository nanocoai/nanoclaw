/**
 * GPT-Live channel — OpenAI's full-duplex voice model (`gpt-live-1`) as the
 * mouth and ears of a call, with the NanoClaw agent as the brain.
 *
 * Shape: native adapter (no Chat SDK bridge). One live voice session is one
 * conversation: `platformId` is the OpenAI session id, there are no threads.
 * The session is created in *client delegation* mode, so whenever the voice
 * model decides a turn needs facts, memory or tools it emits a delegation
 * event; the adapter turns the transcript since the last delegation into an
 * inbound message and the agent's reply comes back as spoken commentary.
 *
 * Transports, in delivery order:
 *  - WebRTC (browser): the call page at `/webhook/gpt-live/call` posts its
 *    SDP offer to `/webhook/gpt-live/sdp`; the host creates the session and
 *    returns the answer. Needs only a URL the caller's browser can reach.
 *  - SIP (phone): OpenAI posts `realtime.call.incoming` to
 *    `/webhook/gpt-live/sip`; the host accepts or rejects. Needs a trunk and
 *    a public webhook URL. Not wired yet (GL-11).
 *
 * Both transports end in the same place: a server-side *sideband* WebSocket
 * attached to the session, which is where transcripts and delegations arrive
 * and where results are pushed. Protocol details and sources:
 * the board's protocol reference page.
 *
 * Credentials: `OPENAI_API_KEY` is read from `.env` on the host, the same
 * way other channel adapters read their tokens. The agent container never
 * sees it — it has no reason to call OpenAI.
 *
 * Scaffold status: registration, defaults, config, HTTP routes and the
 * session bookkeeping are in place; `connectSideband` is the remaining
 * piece (GL-03) and throws until then.
 */
import type http from 'node:http';

import type { ChannelAdapter, ChannelDefaults, ChannelSetup, InboundMessage, OutboundMessage } from './adapter.js';
import { registerChannelAdapter } from './channel-registry.js';
import { GptLiveSession, type LiveClientEvent, type DelegationRequest } from './gpt-live-session.js';
import { readEnvFile } from '../env.js';
import { log } from '../log.js';
import { registerWebhookHandler } from '../webhook-server.js';

export const GPT_LIVE_MODEL = 'gpt-live-1';
const OPENAI_API = 'https://api.openai.com/v1';

/**
 * A voice call is DM-shaped: everything the caller says that the voice model
 * delegates is for the agent (pattern '.'), there are no threads and no
 * platform mention concept. Unknown callers are declined politely and the
 * owner gets a one-line FYI — for SIP this becomes a reject before the
 * session (and its billing) starts.
 */
const GPT_LIVE_DEFAULTS: ChannelDefaults = {
  dm: { engageMode: 'pattern', engagePattern: '.', threads: false, unknownSenderPolicy: 'decline_notify' },
  group: { engageMode: 'pattern', engagePattern: '.', threads: false, unknownSenderPolicy: 'decline_notify' },
  mentions: 'dm-only',
};

export interface GptLiveConfig {
  apiKey: string;
  /** Origin the caller's browser (or OpenAI's webhook sender) can reach the host at. */
  publicUrl: string;
  /** Default voice for new sessions. */
  voice: string;
}

/** Minimal socket surface the adapter needs; satisfied by Node's built-in WebSocket. */
export interface SidebandSocket {
  send(data: string): void;
  close(): void;
}

interface LiveCall {
  session: GptLiveSession;
  socket: SidebandSocket | null;
  /** Who is on the line: `gpt-live:<handle>` — a link token for browser calls, E.164 for SIP. */
  callerHandle: string;
}

/** Voice-side instructions. GL-06 replaces this with a composer over the agent group's personality. */
export function voiceInstructions(agentName: string): string {
  return [
    `You are ${agentName}, speaking on a live call.`,
    'Keep the conversation natural and brief.',
    'Delegate anything that needs facts, memory, tools, scheduling or actions to the backend; do not guess.',
    'While the backend works, keep the caller company with short acknowledgements, never invented answers.',
    'Speak results plainly; no markdown, no lists read aloud as symbols.',
  ].join(' ');
}

/** Build the session config for a new call in client-delegation mode. */
export function sessionConfig(agentName: string, voice: string): Record<string, unknown> {
  return {
    model: GPT_LIVE_MODEL,
    instructions: voiceInstructions(agentName),
    audio: { output: { voice } },
    delegation: { type: 'client' },
  };
}

export function createGptLiveAdapter(config: GptLiveConfig): ChannelAdapter {
  const calls = new Map<string, LiveCall>();
  let setup: ChannelSetup | null = null;
  let connected = false;

  const sendEvent = (call: LiveCall, event: LiveClientEvent): void => {
    if (!call.socket) {
      log.warn('gpt-live: no sideband for session; dropping client event', {
        sessionId: call.session.sessionId,
        type: event.type,
      });
      return;
    }
    call.socket.send(JSON.stringify(event));
  };

  const onDelegation = (req: DelegationRequest): void => {
    if (!setup) return;
    const call = calls.get(req.sessionId);
    if (!call) return;
    const message: InboundMessage = {
      id: `${req.sessionId}:${req.delegationId}`,
      kind: 'chat',
      content: {
        text: req.transcript,
        sender: call.callerHandle,
        gptLive: { delegationId: req.delegationId, offsetMs: req.offsetMs, supersedes: req.supersedes },
      },
      timestamp: new Date().toISOString(),
      isMention: true,
      isGroup: false,
    };
    // Let the voice model know work started; the agent's reply lands via deliver().
    call.session.think('Working on it.');
    void setup.onInbound(req.sessionId, null, message);
  };

  const openCall = (sessionId: string, callerHandle: string): LiveCall => {
    const call: LiveCall = { socket: null, callerHandle, session: null as unknown as GptLiveSession };
    call.session = new GptLiveSession(sessionId, {
      send: (event) => sendEvent(call, event),
      onDelegation,
      onClosed: (reason) => {
        log.info('gpt-live: session closed', { sessionId, reason });
        call.socket?.close();
        calls.delete(sessionId);
      },
    });
    calls.set(sessionId, call);
    return call;
  };

  /**
   * Attach the server-side sideband to a session and pump its events into the
   * state machine. GL-03: implement with Node's built-in WebSocket against
   * `wss://api.openai.com/v1/live/sessions/{id}/attach` (Authorization: Bearer),
   * parse each message as JSON and call `call.session.handle(event)`. GL-15
   * verifies the attach URL against the SDK on a real session first.
   */
  const connectSideband = async (_call: LiveCall): Promise<SidebandSocket> => {
    throw new Error('gpt-live: sideband attach not implemented yet (GL-03)');
  };

  /** Create a WebRTC session from the browser's SDP offer; returns the SDP answer. */
  const createWebRtcSession = async (
    offer: string,
    agentName: string,
  ): Promise<{ sessionId: string; answer: string }> => {
    const res = await fetch(`${OPENAI_API}/live/sessions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        session: sessionConfig(agentName, config.voice),
        transport: { type: 'webrtc', sdp: offer },
      }),
    });
    if (!res.ok) throw new Error(`gpt-live: session create failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
    const body = (await res.json()) as { session?: { id?: string }; transport?: { sdp?: string } };
    if (!body.session?.id || !body.transport?.sdp) throw new Error('gpt-live: session create returned no id/sdp');
    return { sessionId: body.session.id, answer: body.transport.sdp };
  };

  const readBody = async (req: http.IncomingMessage): Promise<string> => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks).toString('utf8');
  };

  /** HTTP routes under /webhook/gpt-live/… on the shared webhook server. */
  const handleHttp = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', config.publicUrl);
    const route = url.pathname.replace(/^\/webhook\/gpt-live\/?/, '');
    try {
      if (req.method === 'GET' && route === 'call') {
        // GL-05: serve the browser call page (getUserMedia → RTCPeerConnection → POST sdp).
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<!doctype html><title>NanoClaw voice</title><p>Call page not built yet (GL-05).</p>');
        return;
      }
      if (req.method === 'POST' && route === 'sdp') {
        const offer = await readBody(req);
        const token = url.searchParams.get('t') ?? 'anonymous';
        const { sessionId, answer } = await createWebRtcSession(offer, 'NanoClaw');
        const call = openCall(sessionId, `gpt-live:${token}`);
        call.socket = await connectSideband(call);
        res.writeHead(200, { 'Content-Type': 'application/sdp' });
        res.end(answer);
        return;
      }
      if (req.method === 'POST' && route === 'sip') {
        // GL-11: realtime.call.incoming → accept (session config) or reject (603) by unknown-sender policy.
        res.writeHead(501, { 'Content-Type': 'text/plain' });
        res.end('SIP not wired yet (GL-11)');
        return;
      }
      res.writeHead(404);
      res.end();
    } catch (err) {
      log.error('gpt-live: http route failed', { route, err });
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('gpt-live error');
    }
  };

  return {
    name: 'gpt-live',
    channelType: 'gpt-live',
    supportsThreads: false,
    defaults: GPT_LIVE_DEFAULTS,

    async setup(cfg: ChannelSetup): Promise<void> {
      setup = cfg;
      registerWebhookHandler('gpt-live', handleHttp);
      connected = true;
      log.info('gpt-live: ready', { callUrl: `${config.publicUrl}/webhook/gpt-live/call`, voice: config.voice });
    },

    async teardown(): Promise<void> {
      for (const call of calls.values()) {
        call.session.close();
        call.socket?.close();
      }
      calls.clear();
      connected = false;
    },

    isConnected(): boolean {
      return connected;
    },

    async deliver(platformId: string, _threadId: string | null, message: OutboundMessage): Promise<string | undefined> {
      const call = calls.get(platformId);
      if (!call) {
        log.warn('gpt-live: deliver to unknown or ended session; dropping', { platformId });
        return undefined;
      }
      const content = message.content as { text?: unknown } | string;
      const text = typeof content === 'string' ? content : typeof content?.text === 'string' ? content.text : '';
      if (!text.trim()) return undefined;
      const ids = call.session.speak(text);
      return ids.at(-1);
    },

    async setTyping(platformId: string, _threadId: string | null, status?: string): Promise<void> {
      const call = calls.get(platformId);
      if (!call) return;
      call.session.think(status?.trim() || 'Still working on it.');
    },
  };
}

registerChannelAdapter('gpt-live', {
  factory: () => {
    const env = readEnvFile(['OPENAI_API_KEY', 'GPT_LIVE_PUBLIC_URL', 'GPT_LIVE_VOICE']);
    if (!env.OPENAI_API_KEY) return null;
    return createGptLiveAdapter({
      apiKey: env.OPENAI_API_KEY,
      publicUrl: (env.GPT_LIVE_PUBLIC_URL || 'http://localhost:3000').replace(/\/+$/, ''),
      voice: env.GPT_LIVE_VOICE || 'marin',
    });
  },
  defaults: GPT_LIVE_DEFAULTS,
});
