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

function configuredEndpoint(): string | undefined {
  const env = readEnvFile(['OPENCODE_BASE_URL', 'ANTHROPIC_BASE_URL']);
  return (
    process.env.OPENCODE_BASE_URL ?? env.OPENCODE_BASE_URL ?? process.env.ANTHROPIC_BASE_URL ?? env.ANTHROPIC_BASE_URL
  );
}

// The shared ANTHROPIC_BASE_URL may be another provider's keyed endpoint, so it never pins a port.
function openCodeEndpoint(): string | undefined {
  return process.env.OPENCODE_BASE_URL ?? readEnvFile(['OPENCODE_BASE_URL']).OPENCODE_BASE_URL;
}

/** Operator-owned endpoint settings are realized when the host starts. */
export function openCodeModelDomains(endpoint = configuredEndpoint()): string[] {
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

/**
 * An endpoint on a non-default port, such as a model server on the host, is
 * declared as its exact host:port; the selected gateway decides the scheme. A
 * default port leaves no port in the URL or the request, so domains cover it.
 */
export function openCodeModelAuthorities(endpoint = openCodeEndpoint()): string[] {
  if (!endpoint || endpoint === 'native') return [];
  try {
    const url = new URL(endpoint);
    if (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      url.port &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(url.hostname)
    )
      return [`${url.hostname}:${url.port}`];
  } catch {
    /* Invalid endpoints are diagnosed by provider configuration. */
  }
  return [];
}

registerProviderHostContract('opencode', {
  seamVersion: 1,
  legacyHostAdapter: 'required',
  ...CLAUDE_COMPATIBLE_HOST_SURFACES,
  modelDomains: openCodeModelDomains(),
  modelAuthorities: openCodeModelAuthorities(),
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
