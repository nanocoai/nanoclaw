/**
 * ElevenLabs text-to-speech. The `xi-api-key` header is injected by the
 * credential gateway for the API host; nothing here reads a key.
 */
import { readAudioResponse } from './http.js';
import { registerTtsProvider } from './registry.js';
import type { SpeechAudio, SpeechRequest, TtsProvider } from './types.js';

const DEFAULT_BASE_URL = 'https://api.elevenlabs.io';
const DEFAULT_MODEL = 'eleven_multilingual_v2';
// A stock voice available to every account.
const DEFAULT_VOICE = '21m00Tcm4TlvDq8ikWAM';

export const elevenLabsProvider: TtsProvider = {
  async synthesize(request: SpeechRequest): Promise<SpeechAudio> {
    const baseUrl = (request.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
    const url = new URL(`${baseUrl}/v1/text-to-speech/${encodeURIComponent(request.voice || DEFAULT_VOICE)}`);
    if (request.format) url.searchParams.set('output_format', request.format);

    const body: Record<string, string> = { text: request.text, model_id: request.model || DEFAULT_MODEL };
    if (request.language) body.language_code = request.language;

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return readAudioResponse(res, 'ElevenLabs', 'audio/mpeg');
  },
};

registerTtsProvider('elevenlabs', elevenLabsProvider);
