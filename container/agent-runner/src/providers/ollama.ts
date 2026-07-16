import { ClaudeProvider } from './claude.js';
import { registerProvider } from './provider-registry.js';
import type { ProviderOptions } from './types.js';

function mergeNoProxy(current: string | undefined, additions: string): string {
  if (!current?.trim()) return additions;
  const parts = new Set(
    current
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter(Boolean),
  );
  for (const addition of additions.split(',')) {
    const trimmed = addition.trim();
    if (trimmed) parts.add(trimmed);
  }
  return [...parts].join(',');
}

class OllamaProvider extends ClaudeProvider {
  constructor(options: ProviderOptions = {}) {
    const baseUrl = process.env.OLLAMA_BASE_URL || 'http://host.docker.internal:11434';
    const ollamaModel = process.env.OLLAMA_MODEL || '';

    super({
      ...options,
      model: ollamaModel || options.model,
      env: {
        ...(options.env ?? {}),
        ANTHROPIC_BASE_URL: baseUrl,
        ANTHROPIC_API_KEY: 'ollama',
        NO_PROXY: mergeNoProxy(options.env?.NO_PROXY, 'host.docker.internal'),
        no_proxy: mergeNoProxy(options.env?.no_proxy, 'host.docker.internal'),
      },
    });
  }
}

registerProvider('ollama', (opts) => new OllamaProvider(opts));
