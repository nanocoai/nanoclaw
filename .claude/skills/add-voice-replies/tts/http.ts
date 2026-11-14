import type { SpeechAudio } from './types.js';

export async function readAudioResponse(res: Response, label: string, fallbackMime: string): Promise<SpeechAudio> {
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`${label} request failed: ${res.status} ${body.slice(0, 300)}`.trim());
  }
  const mimeType = res.headers.get('content-type')?.split(';')[0].trim() || fallbackMime;
  return { data: new Uint8Array(await res.arrayBuffer()), mimeType };
}
