/**
 * Voice transcription — local Whisper, container-side.
 *
 * Sovereignty model: audio never leaves the machine. There is no remote
 * fallback in this module by design; if local transcription fails, the
 * caller decides what to do (typically: surface the failure to the user).
 *
 * Config via env vars:
 *   WHISPER_MODEL_PATH   Path to ggml model file (default: /whisper/model.bin)
 */
import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export const WHISPER_MODEL_PATH = process.env.WHISPER_MODEL_PATH ?? '/whisper/model.bin';

export interface TranscriptionResult {
  text: string;
  source: 'local-whisper';
  durationMs: number;
  model: string;
}

/**
 * Transcribe an audio file via local whisper-cli. Throws if the model is
 * missing or whisper-cli produces no output.
 */
export async function transcribeAudio(filePath: string): Promise<TranscriptionResult> {
  if (!fs.existsSync(WHISPER_MODEL_PATH)) {
    throw new Error(`Whisper model not found at ${WHISPER_MODEL_PATH}.`);
  }
  const start = Date.now();
  const text = await runWhisperCli(filePath);
  return { text, source: 'local-whisper', durationMs: Date.now() - start, model: 'whisper-local' };
}

/**
 * Convert non-WAV audio to 16 kHz mono WAV via ffmpeg. whisper.cpp's CLI only
 * reads WAV/MP3/OGG/FLAC reliably; raw AAC/Opus/AMR (the formats Signal,
 * WhatsApp, and other messengers ship voice notes as) silently produce no
 * output. Always normalize before invoking whisper-cli.
 */
async function toWav(filePath: string): Promise<{ wavPath: string; cleanup: () => void }> {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.wav') {
    return { wavPath: filePath, cleanup: () => {} };
  }
  const tmpWav = path.join(os.tmpdir(), `nanoclaw-transcribe-${Date.now()}.wav`);
  await execFileAsync('ffmpeg', ['-i', filePath, '-ar', '16000', '-ac', '1', tmpWav, '-y']);
  return { wavPath: tmpWav, cleanup: () => fs.unlink(tmpWav, () => {}) };
}

/** Run whisper-cli subprocess. Expects stdout to contain the plain transcript. */
async function runWhisperCli(filePath: string): Promise<string> {
  const { wavPath, cleanup } = await toWav(filePath);
  try {
    // whisper-cli -m <model> -f <file> -nt (no timestamps) outputs plain text to stdout
    const { stdout } = await execFileAsync('whisper-cli', ['-m', WHISPER_MODEL_PATH, '-f', wavPath, '-nt']);
    const text = stdout.trim();
    if (!text) {
      throw new Error('whisper-cli produced no output');
    }
    return text;
  } finally {
    cleanup();
  }
}
