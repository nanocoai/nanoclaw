/**
 * GPT-Live session state machine — the pure half of the gpt-live channel.
 *
 * One instance per live voice session. It consumes the server events the
 * sideband WebSocket delivers (transcript deltas, delegation requests,
 * closure) and produces the client events the adapter sends back (spoken
 * commentary, silent thinking notes). No I/O lives here: the adapter owns
 * the socket, this module owns the bookkeeping, so the tricky parts —
 * where a delegation's transcript starts and ends, what happens when the
 * caller barges in mid-delegation, how a long reply is chunked under the
 * per-append token cap — are unit-testable without a network.
 *
 * Protocol facts this encodes (OpenAI Live API, September 2026):
 *  - `session.delegation.created` carries an id only, never the task text.
 *    The task is whatever was said since the previous delegation, so the
 *    transcript buffer is cut at that event.
 *  - `session.commentary.append` (spoken) and `session.thinking.append`
 *    (silent) each take at most 500 tokens per append; longer text is
 *    split into several appends that share one `delegation_id`.
 *  - A caller interruption never cancels backend work. A newer delegation
 *    supersedes the open one; results for a superseded id are still sent
 *    and the voice model decides whether to voice them.
 */

/** Any server event from the sideband. Only `type` is load-bearing here. */
export interface LiveServerEvent {
  type: string;
  [key: string]: unknown;
}

/** The client events this module emits. The adapter serialises them as-is. */
export type LiveClientEvent =
  | { type: 'session.commentary.append'; event_id: string; delegation_id: string | null; content: string }
  | { type: 'session.thinking.append'; event_id: string; delegation_id: string | null; content: string }
  | { type: 'session.instructions.append'; event_id: string; delegation_id: string | null; content: string }
  | { type: 'session.close' };

/** What the adapter hands to the router when the voice model delegates. */
export interface DelegationRequest {
  sessionId: string;
  delegationId: string;
  /** Turns since the previous delegation, one per line: `Caller: …` / `Assistant: …`. */
  transcript: string;
  /** Position on the session timeline, ms from session start. */
  offsetMs: number;
  /** The delegation id this one supersedes, when the caller barged in mid-task. */
  supersedes: string | null;
}

export interface SessionSink {
  send(event: LiveClientEvent): void;
  onDelegation(request: DelegationRequest): void;
  onClosed(reason: string): void;
}

/**
 * Conservative character budget for one append. The API caps an append at
 * 500 tokens; English prose runs roughly 4 characters per token, and spoken
 * replies skew short-worded, so 1,500 characters leaves headroom.
 */
export const MAX_APPEND_CHARS = 1500;

const CALLER = 'Caller';
const ASSISTANT = 'Assistant';

/** Split text into pieces of at most `max` chars, preferring sentence then word boundaries. */
export function chunkForAppend(text: string, max: number = MAX_APPEND_CHARS): string[] {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) return [];
  if (clean.length <= max) return [clean];
  const out: string[] = [];
  let rest = clean;
  while (rest.length > max) {
    const window = rest.slice(0, max);
    let cut = Math.max(window.lastIndexOf('. '), window.lastIndexOf('? '), window.lastIndexOf('! '));
    if (cut > 0) cut += 1; // keep the punctuation with the sentence
    if (cut < max / 3) cut = window.lastIndexOf(' ');
    if (cut <= 0) cut = max;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out;
}

export class GptLiveSession {
  private readonly lines: string[] = [];
  private speaker: typeof CALLER | typeof ASSISTANT | null = null;
  private partial = '';
  private openDelegation: string | null = null;
  private closed = false;
  private seq = 0;

  constructor(
    readonly sessionId: string,
    private readonly sink: SessionSink,
  ) {}

  /** The delegation the voice model is currently waiting on, if any. */
  currentDelegation(): string | null {
    return this.openDelegation;
  }

  isClosed(): boolean {
    return this.closed;
  }

  /** Feed one server event from the sideband. */
  handle(event: LiveServerEvent): void {
    if (this.closed) return;
    switch (event.type) {
      case 'session.input_transcript.delta':
        this.appendTranscript(CALLER, event.delta);
        return;
      case 'session.output_transcript.delta':
        this.appendTranscript(ASSISTANT, event.delta);
        return;
      case 'session.delegation.created':
        this.onDelegationCreated(event);
        return;
      case 'session.closed':
      case 'transport.failed':
        this.closed = true;
        this.sink.onClosed(event.type);
        return;
      default:
        // Acknowledgements (`*.appended`), usage, transport lifecycle, errors:
        // nothing to track yet. GL-01 adds ack bookkeeping keyed on event_id.
        return;
    }
  }

  /**
   * Speak `text` to the caller. Chunked under the per-append cap; every chunk
   * carries the same delegation id — the open one unless the adapter names a
   * specific (possibly superseded) delegation the reply belongs to.
   * Returns the event ids sent, in order.
   */
  speak(text: string, delegationId: string | null = this.openDelegation): string[] {
    return this.emit('session.commentary.append', text, delegationId);
  }

  /** Silent progress note for the voice model ("still working"). */
  think(text: string, delegationId: string | null = this.openDelegation): string[] {
    return this.emit('session.thinking.append', text, delegationId);
  }

  /** Steer the voice model; may interrupt its current speech. */
  instruct(text: string, delegationId: string | null = null): string[] {
    return this.emit('session.instructions.append', text, delegationId);
  }

  /** Ask the server to end the session. */
  close(): void {
    if (this.closed) return;
    this.sink.send({ type: 'session.close' });
  }

  private emit(
    type: 'session.commentary.append' | 'session.thinking.append' | 'session.instructions.append',
    text: string,
    delegationId: string | null,
  ): string[] {
    if (this.closed) return [];
    const ids: string[] = [];
    for (const content of chunkForAppend(text)) {
      const event_id = this.nextEventId();
      ids.push(event_id);
      this.sink.send({ type, event_id, delegation_id: delegationId, content });
    }
    return ids;
  }

  private nextEventId(): string {
    this.seq += 1;
    return `nc_${this.sessionId}_${this.seq}`;
  }

  private appendTranscript(speaker: typeof CALLER | typeof ASSISTANT, delta: unknown): void {
    if (typeof delta !== 'string' || !delta) return;
    if (this.speaker !== speaker) this.flushPartial();
    this.speaker = speaker;
    this.partial += delta;
  }

  private flushPartial(): void {
    const text = this.partial.trim();
    if (text && this.speaker) this.lines.push(`${this.speaker}: ${text}`);
    this.partial = '';
    this.speaker = null;
  }

  private onDelegationCreated(event: LiveServerEvent): void {
    const delegation = event.delegation as { id?: unknown } | undefined;
    const id = typeof delegation?.id === 'string' ? delegation.id : null;
    if (!id) return;
    this.flushPartial();
    const transcript = this.lines.join('\n');
    this.lines.length = 0;
    const supersedes = this.openDelegation;
    this.openDelegation = id;
    this.sink.onDelegation({
      sessionId: this.sessionId,
      delegationId: id,
      transcript,
      offsetMs: typeof event.offset_ms === 'number' ? event.offset_ms : 0,
      supersedes,
    });
  }
}
