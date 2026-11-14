import type { TtsProvider } from './types.js';

const providers = new Map<string, TtsProvider>();

export function registerTtsProvider(name: string, provider: TtsProvider): void {
  if (providers.has(name)) throw new Error(`TTS provider already registered: ${name}`);
  providers.set(name, provider);
}

export function getTtsProvider(name: string): TtsProvider {
  const provider = providers.get(name);
  if (!provider) {
    const known = [...providers.keys()].join(', ') || '(none)';
    throw new Error(`Unknown TTS provider "${name}". Registered: ${known}`);
  }
  return provider;
}

export function listTtsProviders(): string[] {
  return [...providers.keys()];
}
