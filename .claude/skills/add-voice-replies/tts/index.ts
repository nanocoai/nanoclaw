// TTS provider barrel. Each import registers one provider; add a provider
// by appending its import.
import './espeak.js';
import './openai-compatible.js';
import './elevenlabs.js';

export { getTtsProvider, listTtsProviders, registerTtsProvider } from './registry.js';
export type { SpeechAudio, SpeechRequest, TtsProvider } from './types.js';
