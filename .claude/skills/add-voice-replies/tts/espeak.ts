/**
 * Offline text-to-speech with espeak-ng. No network, no credential. The
 * binary comes from the group's apt packages (`espeak-ng`). `voice` is an
 * espeak voice or language code (`en`, `en-us`, `de`, `es`, ...).
 */
import { spawn } from 'child_process';

import { registerTtsProvider } from './registry.js';
import type { SpeechAudio, SpeechRequest, TtsProvider } from './types.js';

export function espeakArgs(request: SpeechRequest): string[] {
  const voice = request.voice || request.language || 'en';
  return ['--stdout', '-v', voice, request.text];
}

export function createEspeakProvider(command = 'espeak-ng'): TtsProvider {
  return {
    synthesize(request: SpeechRequest): Promise<SpeechAudio> {
      return new Promise((resolve, reject) => {
        const proc = spawn(command, espeakArgs(request), { stdio: ['ignore', 'pipe', 'pipe'] });
        const out: Buffer[] = [];
        const errOut: Buffer[] = [];
        proc.stdout.on('data', (chunk: Buffer) => out.push(chunk));
        proc.stderr.on('data', (chunk: Buffer) => errOut.push(chunk));
        proc.on('error', (err) => reject(new Error(`${command} failed to start: ${err.message}`)));
        proc.on('close', (code) => {
          if (code !== 0) {
            const stderr = Buffer.concat(errOut).toString('utf8').trim().slice(0, 300);
            reject(new Error(`${command} exited with code ${code}: ${stderr}`));
            return;
          }
          resolve({ data: new Uint8Array(Buffer.concat(out)), mimeType: 'audio/wav' });
        });
      });
    },
  };
}

registerTtsProvider('espeak', createEspeakProvider());
