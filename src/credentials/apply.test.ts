import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyCredentialDecisions } from './apply.js';

describe('applyCredentialDecisions', () => {
  let tmp: string;
  let sessionDir: string;
  let fakeHome: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-apply-test-'));
    sessionDir = path.join(tmp, 'session');
    fakeHome = path.join(tmp, 'home');
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.mkdirSync(path.join(fakeHome, '.codex'), { recursive: true });
    fs.writeFileSync(path.join(fakeHome, '.codex', 'auth.json'), '{"x":1}');
  });

  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('fallback decisions produce an empty contribution and no refusal', () => {
    const result = applyCredentialDecisions([{ kind: 'fallback' }], sessionDir, {} as NodeJS.ProcessEnv);
    expect(result.refusal).toBeNull();
    expect(result.contribution).toEqual({ mounts: [], env: {} });
  });

  it('gateway_secret with anthropic injection wires baseUrl + placeholder env', () => {
    const result = applyCredentialDecisions(
      [
        {
          kind: 'gateway_secret',
          providerId: 'anthropic',
          baseUrl: 'https://gateway.example/anthropic',
          placeholderToken: 'placeholder',
          injection: { header: 'authorization', scheme: 'Bearer' },
          refreshPolicy: 'gateway',
        },
      ],
      sessionDir,
      {} as NodeJS.ProcessEnv,
    );
    expect(result.refusal).toBeNull();
    expect(result.contribution.env).toEqual({
      ANTHROPIC_BASE_URL: 'https://gateway.example/anthropic',
      ANTHROPIC_AUTH_TOKEN: 'placeholder',
    });
    expect(result.contribution.mounts).toEqual([]);
  });

  it('gateway_secret with openai injection wires OPENAI_BASE_URL + OPENAI_API_KEY placeholder', () => {
    const result = applyCredentialDecisions(
      [
        {
          kind: 'gateway_secret',
          providerId: 'openai',
          baseUrl: 'https://gateway.example/openai/v1',
          placeholderToken: 'placeholder',
          refreshPolicy: 'gateway',
        },
      ],
      sessionDir,
      {} as NodeJS.ProcessEnv,
    );
    expect(result.contribution.env).toEqual({
      OPENAI_BASE_URL: 'https://gateway.example/openai/v1',
      OPENAI_API_KEY: 'placeholder',
    });
  });

  it('native_auth_bundle materializes and adds a mount', () => {
    const result = applyCredentialDecisions(
      [
        {
          kind: 'native_auth_bundle',
          providerId: 'codex',
          bundleRef: 'host:~/.codex/auth.json',
          mountPath: '/home/node/.codex/auth.json',
          refreshPolicy: 'runtime',
        },
      ],
      sessionDir,
      { HOME: fakeHome } as NodeJS.ProcessEnv,
    );
    expect(result.refusal).toBeNull();
    expect(result.contribution.mounts).toHaveLength(1);
    expect(result.contribution.mounts[0].containerPath).toBe('/home/node/.codex/auth.json');
  });

  it('forbidden produces a refusal and no contribution', () => {
    const result = applyCredentialDecisions(
      [{ kind: 'forbidden', provider: 'codex', reason: 'policy' }],
      sessionDir,
      {} as NodeJS.ProcessEnv,
    );
    expect(result.refusal).toEqual({
      kind: 'forbidden',
      provider: 'codex',
      reason: 'policy',
    });
    expect(result.contribution).toEqual({ mounts: [], env: {} });
  });

  it('connect_required produces a refusal with message', () => {
    const result = applyCredentialDecisions(
      [
        {
          kind: 'connect_required',
          provider: 'codex',
          message: 'Sign in to OpenAI',
          connectUrl: 'https://nanoclaw.example/connect',
        },
      ],
      sessionDir,
      {} as NodeJS.ProcessEnv,
    );
    expect(result.refusal).toEqual({
      kind: 'connect_required',
      provider: 'codex',
      message: 'Sign in to OpenAI',
      connectUrl: 'https://nanoclaw.example/connect',
    });
  });

  it('first refusal wins; later decisions are ignored', () => {
    const result = applyCredentialDecisions(
      [
        { kind: 'forbidden', provider: 'codex' },
        {
          kind: 'gateway_secret',
          providerId: 'openai',
          baseUrl: 'https://gateway.example/openai/v1',
          placeholderToken: 'placeholder',
        },
      ],
      sessionDir,
      {} as NodeJS.ProcessEnv,
    );
    expect(result.refusal?.kind).toBe('forbidden');
    expect(result.contribution.env).toEqual({});
  });
});
