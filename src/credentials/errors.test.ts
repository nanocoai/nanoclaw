import { describe, expect, it } from 'vitest';
import { HTTP_STATUS_CONNECT_REQUIRED, HTTP_STATUS_FORBIDDEN, serializeCredentialError } from './errors.js';
import type { CredentialDecision } from './types.js';

describe('credential error envelopes', () => {
  it('HTTP statuses match the spec', () => {
    expect(HTTP_STATUS_CONNECT_REQUIRED).toBe(402);
    expect(HTTP_STATUS_FORBIDDEN).toBe(403);
  });

  it('serializes connect_required to a 402 envelope', () => {
    const decision: CredentialDecision = {
      kind: 'connect_required',
      provider: 'codex',
      message: 'Connect your OpenAI account to continue.',
      connectUrl: 'https://nanoclaw.example/connect/openai',
    };
    expect(serializeCredentialError(decision)).toEqual({
      status: 402,
      body: {
        type: 'connect_required',
        provider: 'codex',
        message: 'Connect your OpenAI account to continue.',
        connect_url: 'https://nanoclaw.example/connect/openai',
      },
    });
  });

  it('serializes forbidden to a 403 envelope', () => {
    const decision: CredentialDecision = {
      kind: 'forbidden',
      provider: 'codex',
      reason: 'agent group not allowed to use codex',
    };
    expect(serializeCredentialError(decision)).toEqual({
      status: 403,
      body: {
        type: 'forbidden',
        provider: 'codex',
        reason: 'agent group not allowed to use codex',
      },
    });
  });

  it('omits optional fields when undefined', () => {
    const decision: CredentialDecision = {
      kind: 'forbidden',
      provider: 'codex',
    };
    const { body } = serializeCredentialError(decision);
    expect(body).toEqual({ type: 'forbidden', provider: 'codex' });
    expect('reason' in body).toBe(false);
  });

  it('omits connect_url when connectUrl is undefined', () => {
    const decision: CredentialDecision = {
      kind: 'connect_required',
      provider: 'codex',
      message: 'Sign in',
    };
    const { body } = serializeCredentialError(decision);
    expect(body).toEqual({ type: 'connect_required', provider: 'codex', message: 'Sign in' });
    expect('connect_url' in body).toBe(false);
  });
});
