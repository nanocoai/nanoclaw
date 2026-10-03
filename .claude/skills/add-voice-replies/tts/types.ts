/** Resolved per-call settings. Every field except `text` is optional provider configuration. */
export interface SpeechRequest {
  text: string;
  voice?: string;
  model?: string;
  baseUrl?: string;
  language?: string;
  format?: string;
}

export interface SpeechAudio {
  data: Uint8Array;
  mimeType: string;
}

export interface TtsProvider {
  synthesize(request: SpeechRequest): Promise<SpeechAudio>;
}
