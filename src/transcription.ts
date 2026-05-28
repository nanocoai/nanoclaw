/**
 * Voice-message transcription via the OpenAI Whisper API.
 *
 * Host-side preprocessing — called by the chat-sdk-bridge after downloading
 * a voice attachment, before the row is written into the session inbound DB.
 * The resulting text is stored on the attachment as `transcription` so the
 * container-side formatter can render it inline; on failure
 * `transcriptionError` carries the reason instead.
 *
 * The container does NOT have access to the OpenAI API key — running Whisper
 * inside the sandboxed agent would require leaking a host secret and would
 * waste tokens on already-spoken content. Transcribing on the host once,
 * then sending the text to the agent, is much cheaper.
 *
 * Reads the key from the host's `.env` (via `readEnvFile`) on first use;
 * missing key returns a structured "OPENAI_API_KEY not set" error so the
 * formatter can surface it to the agent.
 */
import { readEnvFile } from './env.js';
import { log } from './log.js';

const WHISPER_ENDPOINT = 'https://api.openai.com/v1/audio/transcriptions';
const WHISPER_MODEL = 'whisper-1';

/**
 * Maximum audio byte size accepted by Whisper. OpenAI's documented cap is
 * 25 MB; we round down slightly so we don't get rejected on the boundary
 * after multipart-form overhead.
 */
const MAX_AUDIO_BYTES = 24 * 1024 * 1024;

let _cachedKey: string | null | undefined;
function getOpenAIKey(): string | null {
  if (_cachedKey !== undefined) return _cachedKey;
  const fromProcess = process.env.OPENAI_API_KEY;
  if (fromProcess && fromProcess.trim().length > 0) {
    _cachedKey = fromProcess.trim();
    return _cachedKey;
  }
  const fromFile = readEnvFile(['OPENAI_API_KEY']).OPENAI_API_KEY;
  _cachedKey = fromFile && fromFile.trim().length > 0 ? fromFile.trim() : null;
  return _cachedKey;
}

/** Test-only reset of the cached key (forces re-read on next call). */
export function resetTranscriptionCacheForTests(): void {
  _cachedKey = undefined;
}

export interface TranscribeOptions {
  /** Optional override for the model name (defaults to `whisper-1`). */
  model?: string;
  /** Optional fetch implementation (tests inject this). */
  fetchImpl?: typeof fetch;
}

export interface TranscribeResult {
  text: string;
}

export class TranscriptionError extends Error {
  readonly kind: 'no-key' | 'too-large' | 'http' | 'network' | 'malformed-response';
  constructor(kind: TranscriptionError['kind'], message: string) {
    super(message);
    this.kind = kind;
    this.name = 'TranscriptionError';
  }
}

/**
 * Transcribe an audio buffer via Whisper. Returns the text on success;
 * throws `TranscriptionError` with a structured `kind` on failure. The
 * caller is expected to convert the error message into
 * `attachment.transcriptionError`.
 */
export async function transcribeAudio(
  audio: Buffer,
  filename: string,
  mimeType: string,
  opts: TranscribeOptions = {},
): Promise<TranscribeResult> {
  const key = getOpenAIKey();
  if (!key) throw new TranscriptionError('no-key', 'OPENAI_API_KEY not set');
  if (audio.length === 0) throw new TranscriptionError('too-large', 'Empty audio buffer');
  if (audio.length > MAX_AUDIO_BYTES) {
    throw new TranscriptionError(
      'too-large',
      `Audio exceeds Whisper limit (${audio.length} > ${MAX_AUDIO_BYTES} bytes)`,
    );
  }

  const form = new FormData();
  form.append('file', new Blob([audio.buffer as ArrayBuffer], { type: mimeType }), filename);
  form.append('model', opts.model ?? WHISPER_MODEL);
  form.append('response_format', 'json');

  const fetchImpl = opts.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await fetchImpl(WHISPER_ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}` },
      body: form,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new TranscriptionError('network', `Whisper network error: ${msg}`);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new TranscriptionError('http', `Whisper HTTP ${res.status}: ${body.slice(0, 300) || res.statusText}`);
  }

  let parsed: unknown;
  try {
    parsed = await res.json();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new TranscriptionError('malformed-response', `Whisper response not JSON: ${msg}`);
  }

  if (parsed === null || typeof parsed !== 'object' || typeof (parsed as { text?: unknown }).text !== 'string') {
    throw new TranscriptionError('malformed-response', 'Whisper response missing "text" field');
  }

  const text = ((parsed as { text: string }).text || '').trim();
  if (!text) throw new TranscriptionError('malformed-response', 'Whisper returned empty text');

  log.debug('Transcribed audio attachment', { filename, mimeType, length: text.length });
  return { text };
}

/**
 * True if the given mime type is one Whisper accepts. Used by the bridge to
 * gate the transcription call. We don't try to transcode unsupported
 * formats — better to let the agent see the file with a clear "no
 * transcription available" note than to silently produce bad text.
 */
export function isTranscribableMime(mime: string | undefined): boolean {
  if (!mime) return false;
  const m = mime.toLowerCase();
  // Conservative whitelist; Whisper actually accepts more but these are the
  // ones the chat platforms we use produce in practice.
  return (
    m.startsWith('audio/') ||
    m === 'video/mp4' || // some Slack voice notes
    m === 'video/webm' // some Telegram round-video voice notes
  );
}
