/**
 * Auto-transcription preprocessing for the poll loop.
 *
 * Before messages reach the formatter/agent, this pass finds audio attachments
 * and injects the transcript inline with a source label:
 *
 *   [Voice (local-whisper): "Can you review the PR before EOD?"]
 *   [Voice: transcription failed — <reason>]
 *
 * The source label is mandatory — it lets the agent disclose to the user how
 * the audio was processed, satisfying the sovereignty model.
 *
 * If transcription fails, the label includes the error so the agent can
 * inform the user rather than silently dropping the content.
 */
import path from 'path';

import type { MessageInRow } from './db/messages-in.js';
import { transcribeAudio } from './transcription.js';

function log(msg: string): void {
  console.error(`[auto-transcribe] ${msg}`);
}

const AUDIO_EXTENSIONS = new Set([
  '.ogg',
  '.opus',
  '.mp3',
  '.m4a',
  '.mp4',
  '.wav',
  '.flac',
  '.webm',
  '.aac',
  '.amr',
  '.3gp',
]);

function isAudioAttachment(att: Record<string, unknown>): boolean {
  const name = String(att.name ?? att.filename ?? '');
  const mime = String(att.mimeType ?? att.type ?? '');
  if (mime.startsWith('audio/')) return true;
  return AUDIO_EXTENSIONS.has(path.extname(name).toLowerCase());
}

/**
 * Preprocess a batch of inbound messages: transcribe any audio attachments and
 * inject the result into the message text. Returns new MessageInRow objects
 * with updated content — the originals are not mutated.
 *
 * Non-chat messages and messages without audio attachments are returned as-is.
 */
export async function autoTranscribeMessages(messages: MessageInRow[]): Promise<MessageInRow[]> {
  const results: MessageInRow[] = [];
  for (const msg of messages) {
    results.push(await preprocessMessage(msg));
  }
  return results;
}

async function preprocessMessage(msg: MessageInRow): Promise<MessageInRow> {
  // Only auto-transcribe chat messages — tasks, system, webhook pass through.
  if (msg.kind !== 'chat' && msg.kind !== 'chat-sdk') return msg;

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(msg.content);
  } catch {
    return msg;
  }

  const attachments = parsed.attachments as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(attachments) || attachments.length === 0) return msg;

  const audioAtts = attachments.filter(isAudioAttachment);
  if (audioAtts.length === 0) return msg;

  const labels: string[] = [];
  for (const att of audioAtts) {
    const localPath = att.localPath as string | undefined;
    if (!localPath) {
      log(`Audio attachment has no localPath, skipping: ${String(att.name ?? '')}`);
      continue;
    }
    // localPath is relative to /workspace/ inside the container
    const fullPath = localPath.startsWith('/') ? localPath : `/workspace/${localPath}`;
    const name = String(att.name ?? att.filename ?? 'audio');

    try {
      const result = await transcribeAudio(fullPath);
      labels.push(`[Voice (${result.source}): "${result.text}"]`);
      log(`Transcribed ${name} via ${result.source} in ${result.durationMs}ms`);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      labels.push(`[Voice: transcription failed — ${errMsg}]`);
      log(`Transcription failed for ${name}: ${errMsg}`);
    }
  }

  if (labels.length === 0) return msg;

  const existingText = String(parsed.text ?? '');
  const injected = labels.join('\n') + (existingText ? '\n' + existingText : '');

  return { ...msg, content: JSON.stringify({ ...parsed, text: injected }) };
}
