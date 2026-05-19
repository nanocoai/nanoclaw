import { describe, expect, it } from 'vitest';

import {
  buildOpenAiSecretCreateArgs,
  hasOpenAiSecret,
  parseCodexAuthMode,
  type OnecliSecretSummary,
} from './codex-auth.js';

describe('codex auth helpers', () => {
  it('parses supported auth modes case-insensitively', () => {
    expect(parseCodexAuthMode('API')).toBe('api');
    expect(parseCodexAuthMode(' subscription ')).toBe('subscription');
    expect(parseCodexAuthMode('skip')).toBe('skip');
    expect(parseCodexAuthMode('other')).toBeNull();
  });

  it('builds an OpenAI OneCLI secret command without shell interpolation', () => {
    expect(buildOpenAiSecretCreateArgs('sk-test')).toEqual([
      'secrets',
      'create',
      '--name',
      'OpenAI',
      '--type',
      'openai',
      '--value',
      'sk-test',
      '--host-pattern',
      'api.openai.com',
    ]);
  });

  it('recognizes existing OpenAI secrets by type or host pattern', () => {
    const secrets: OnecliSecretSummary[] = [
      { id: 'a', name: 'Other', type: 'generic', hostPattern: 'api.example.com' },
      { id: 'b', name: 'OpenAI', type: 'generic', hostPattern: 'api.openai.com' },
    ];

    expect(hasOpenAiSecret(secrets)).toBe(true);
  });
});
