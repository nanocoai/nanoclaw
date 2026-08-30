import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { readOllamaModelState, resolveOllamaWebBrowsing } from './ollama.js';
import { getProviderContainerConfig } from './provider-container-registry.js';

async function contribution(model?: string, hostEnv: NodeJS.ProcessEnv = {}) {
  return getProviderContainerConfig('ollama')!({
    sessionDir: '/tmp/session',
    agentGroupId: 'ag-test',
    model,
    groupDir: '/tmp/group',
    selectedSkills: [],
    hostEnv,
  });
}

describe('ollama host provider configuration', () => {
  it('routes only through the local daemon and blocks direct cloud hosts', async () => {
    const config = await contribution('qwen3:8b');
    expect(config.blockedHosts).toEqual([
      'api.anthropic.com',
      'claude.ai',
      'www.claude.ai',
      'statsig.anthropic.com',
      'platform.claude.com',
      'mcp-proxy.anthropic.com',
      'code.claude.com',
      'claude.com',
    ]);
    expect(config.env).toMatchObject({
      ANTHROPIC_BASE_URL: 'http://host.docker.internal:11434',
      ANTHROPIC_AUTH_TOKEN: 'ollama',
      CLAUDE_CODE_OAUTH_TOKEN: '',
      ANTHROPIC_API_KEY: '',
      CLAUDE_CODE_MAX_RETRIES: '0',
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: '8192',
      CLAUDE_CODE_TOTAL_TOKENS_REMINDER: 'off',
      CLAUDE_CODE_TODO_REMINDER_MODE: 'off',
      CLAUDE_CODE_DISABLE_WORKFLOWS: '1',
      CLAUDE_CODE_DISABLE_CRON: '1',
      CLAUDE_CODE_DISABLE_CLAUDE_API_SKILL: '1',
      CLAUDE_CODE_SUBAGENT_MODEL: 'qwen3:8b',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'qwen3:8b',
      NANOCLAW_OLLAMA_WEB_BROWSING: 'disabled',
    });
    expect(config.env?.NO_PROXY?.split(',')).toEqual([
      '127.0.0.1',
      'localhost',
      'host.docker.internal',
      ...config.blockedHosts!,
    ]);
  });

  it('enables hosted browsing only from the explicit non-secret flag', async () => {
    const config = await contribution('qwen3:8b', { OLLAMA_WEB_BROWSING: 'enabled' });
    expect(config.env?.NANOCLAW_OLLAMA_WEB_BROWSING).toBe('enabled');
    expect(resolveOllamaWebBrowsing({ OLLAMA_WEB_BROWSING: 'disabled' })).toBe('disabled');
    expect(() => resolveOllamaWebBrowsing({ OLLAMA_WEB_BROWSING: 'yes' })).toThrow('must be "enabled" or "disabled"');
  });

  it('rejects credentials in the configured Ollama URL', async () => {
    await expect(
      contribution('qwen3:8b', { OLLAMA_BASE_URL: 'http://user:secret@host.docker.internal:11434' }),
    ).rejects.toThrow('without credentials');
  });

  it('uses a valid launch alias only for its configured source model', () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-ollama-provider-'));
    const stateDir = path.join(dataDir, 'provider-state', 'ollama');
    fs.mkdirSync(stateDir, { recursive: true });
    const key = createHash('sha256').update('qwen3:30b').digest('hex');
    fs.writeFileSync(
      path.join(stateDir, `${key}.json`),
      '{"source":"qwen3:30b","runtime":"nanoclaw/abc:latest","contextLength":131072}\n',
    );
    try {
      expect(readOllamaModelState('qwen3:30b', dataDir)).toEqual({
        runtimeModel: 'nanoclaw/abc:latest',
        contextLength: 131072,
      });
      expect(readOllamaModelState('gemma4:12b', dataDir)).toBeUndefined();
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('surfaces corrupt model state and requires a model', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-ollama-corrupt-'));
    const stateDir = path.join(dataDir, 'provider-state', 'ollama');
    fs.mkdirSync(stateDir, { recursive: true });
    const key = createHash('sha256').update('qwen3:30b').digest('hex');
    fs.writeFileSync(path.join(stateDir, `${key}.json`), '{ this is not json');
    try {
      expect(() => readOllamaModelState('qwen3:30b', dataDir)).toThrow('invalid Ollama model state');
      await expect(contribution()).rejects.toThrow('requires a valid model');
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
