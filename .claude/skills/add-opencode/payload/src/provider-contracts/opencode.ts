import { readEnvFile } from '../env.js';
import { CLAUDE_COMPATIBLE_HOST_SURFACES } from './claude.js';
import { registerProviderHostContract } from './registry.js';

const NATIVE_MODEL_DOMAINS = [
  'api.openai.com',
  'chatgpt.com',
  'openrouter.ai',
  'api.deepseek.com',
  'generativelanguage.googleapis.com',
  'api.anthropic.com',
];

/** Operator-owned endpoint settings are realized when the host starts. */
export function openCodeModelDomains(endpoint?: string): string[] {
  if (endpoint === undefined) {
    const env = readEnvFile(['OPENCODE_BASE_URL', 'ANTHROPIC_BASE_URL']);
    endpoint =
      process.env.OPENCODE_BASE_URL ??
      env.OPENCODE_BASE_URL ??
      process.env.ANTHROPIC_BASE_URL ??
      env.ANTHROPIC_BASE_URL;
  }
  const domains = [...NATIVE_MODEL_DOMAINS];
  if (endpoint && endpoint !== 'native') {
    try {
      const url = new URL(endpoint);
      if (
        url.protocol === 'https:' &&
        !url.port &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash &&
        /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(url.hostname)
      )
        domains.push(url.hostname);
    } catch {
      /* Invalid endpoints are diagnosed by provider configuration. */
    }
  }
  return [...new Set(domains)];
}

registerProviderHostContract('opencode', {
  seamVersion: 1,
  legacyHostAdapter: 'required',
  ...CLAUDE_COMPATIBLE_HOST_SURFACES,
  modelDomains: openCodeModelDomains(),
  stateVolumes: [
    ...CLAUDE_COMPATIBLE_HOST_SURFACES.stateVolumes,
    {
      id: 'opencode-xdg',
      directory: 'opencode-xdg',
      containerPath: '/opencode-xdg',
      scope: 'session',
      mode: 'rw',
      mountClass: 'allowlisted-extra',
    },
  ],
  commands: { nativeAdmin: [], nativeFiltered: [] },
});
