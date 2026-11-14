/**
 * Any server that implements `POST <baseUrl>/audio/speech` in the OpenAI
 * shape: a local speech server on the host (no credential), or the hosted
 * OpenAI API, whose Authorization header the credential gateway injects.
 */
import { readAudioResponse } from './http.js';
import { registerTtsProvider } from './registry.js';
import type { SpeechAudio, SpeechRequest, TtsProvider } from './types.js';

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_MODEL = 'tts-1';
const DEFAULT_VOICE = 'alloy';

export const openAiCompatibleProvider: TtsProvider = {
  async synthesize(request: SpeechRequest): Promise<SpeechAudio> {
    const baseUrl = (request.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
    const body: Record<string, string> = {
      model: request.model || DEFAULT_MODEL,
      voice: request.voice || DEFAULT_VOICE,
      input: request.text,
    };
    if (request.format) body.response_format = request.format;

    const res = await fetch(`${baseUrl}/audio/speech`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return readAudioResponse(res, 'Speech endpoint', 'audio/mpeg');
  },
};

registerTtsProvider('openai', openAiCompatibleProvider);
