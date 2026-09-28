/**
 * Server-side sideband for the Live Voice channel.
 *
 * A live voice session's audio flows browser-to-OpenAI (WebRTC) or
 * trunk-to-OpenAI (SIP); the host is not in that path. The sideband is a
 * second WebSocket the host attaches to the running session to receive
 * transcripts and delegation events and to push results. URL and auth are
 * the ones the OpenAI SDK builds: `/v1/live/sessions/{id}/attach` with a
 * bearer header. Node's built-in WebSocket client carries the header
 * (undici's non-standard `headers` option).
 *
 * Kept separate from the adapter so a live probe can attach with the exact
 * production code.
 */
import type { LiveServerEvent } from './gpt-live-session.js';
import { log } from '../log.js';

/** The socket surface the adapter needs; Node's built-in WebSocket provides it. */
export interface SidebandSocket {
  send(data: string): void;
  close(): void;
}

export interface AttachOptions {
  /** e.g. `wss://api.openai.com/v1` */
  wsBase: string;
  apiKey: string;
  sessionId: string;
  onEvent: (event: LiveServerEvent) => void;
  onClose: (code: number, reason: string) => void;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export function sidebandUrl(wsBase: string, sessionId: string): string {
  return `${wsBase.replace(/\/+$/, '')}/live/sessions/${encodeURIComponent(sessionId)}/attach`;
}

/** Attach to a session; resolves once the socket is open, rejects if the handshake fails. */
export function attachSideband(opts: AttachOptions): Promise<SidebandSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(sidebandUrl(opts.wsBase, opts.sessionId), {
      headers: { Authorization: `Bearer ${opts.apiKey}` },
    });
    let opened = false;
    let finished = false;
    const clearDeadline = () => {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', cancelled);
    };
    const fail = (message: string) => {
      if (finished) return;
      finished = true;
      clearDeadline();
      ws.close();
      reject(new Error(message));
    };
    const cancelled = () => fail('gpt-live: sideband attach cancelled');
    const timer = setTimeout(() => fail('gpt-live: sideband attach timed out'), opts.timeoutMs ?? 15_000);
    opts.signal?.addEventListener('abort', cancelled, { once: true });
    if (opts.signal?.aborted) cancelled();
    ws.addEventListener('open', () => {
      if (finished) {
        ws.close();
        return;
      }
      opened = true;
      clearDeadline();
      log.info('gpt-live: sideband attached', { sessionId: opts.sessionId });
      resolve({
        send: (data) => {
          if (finished) throw new Error('gpt-live: sideband is closed');
          ws.send(data);
        },
        close: () => {
          if (finished) return;
          finished = true;
          ws.close();
        },
      });
    });
    ws.addEventListener('message', (ev: MessageEvent) => {
      if (finished || !opened || typeof ev.data !== 'string') return;
      let event: { type?: unknown } & Record<string, unknown>;
      try {
        event = JSON.parse(ev.data) as { type?: unknown } & Record<string, unknown>;
      } catch (err) {
        log.warn('gpt-live: unparseable sideband frame', { sessionId: opts.sessionId, err });
        return;
      }
      if (typeof event.type !== 'string') return;
      if (event.type === 'error')
        log.warn('gpt-live: session error event', { sessionId: opts.sessionId, error: event.error });
      opts.onEvent({ ...event, type: event.type });
    });
    ws.addEventListener('error', () => {
      if (!opened) fail('gpt-live: sideband attach failed');
      else log.warn('gpt-live: sideband socket error', { sessionId: opts.sessionId });
    });
    ws.addEventListener('close', (ev: { code: number; reason: string }) => {
      if (!opened) return fail('gpt-live: sideband closed before opening');
      if (finished) return;
      finished = true;
      opts.onClose(ev.code, ev.reason);
    });
  });
}
