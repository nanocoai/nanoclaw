import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';

import './codex.js';
import { getProviderContainerConfig } from './provider-container-registry.js';

describe('codex provider container config', () => {
  it('mounts isolated Codex state and writes auth JSON', () => {
    const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-codex-provider-'));
    const config = getProviderContainerConfig('codex');

    expect(config).toBeDefined();

    const contribution = config!({
      sessionDir,
      agentGroupId: 'agent-1',
      hostEnv: { CODEX_AUTH_JSON: '{"tokens":{"access_token":"token"}}' },
    });

    expect(contribution.env?.CODEX_HOME).toBe('/home/node/.codex');
    expect(contribution.mounts).toEqual([
      {
        hostPath: path.join(sessionDir, '.codex'),
        containerPath: '/home/node/.codex',
        readonly: false,
      },
    ]);
    expect(fs.readFileSync(path.join(sessionDir, '.codex', 'auth.json'), 'utf8')).toContain('access_token');
  });

  it('passes explicit API auth through env', () => {
    const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-codex-provider-'));
    const config = getProviderContainerConfig('codex')!;

    const contribution = config({
      sessionDir,
      agentGroupId: 'agent-1',
      hostEnv: {
        OPENAI_API_KEY: 'sk-test',
        CODEX_ACCESS_TOKEN: 'access-test',
      },
    });

    expect(contribution.env?.OPENAI_API_KEY).toBe('sk-test');
    expect(contribution.env?.CODEX_ACCESS_TOKEN).toBe('access-test');
  });
});
