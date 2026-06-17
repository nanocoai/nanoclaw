import { describe, expect, it } from 'vitest';

import { composeAnthropicEnv } from './claude.js';

describe('composeAnthropicEnv', () => {
  it('returns no env when no custom base URL is configured', () => {
    // Standard api.anthropic.com installs don't load this provider at all.
    expect(composeAnthropicEnv(undefined, {})).toEqual({});
  });

  it('uses the OneCLI placeholder bearer when no fleet token is set', () => {
    // Default custom-endpoint path: the proxy overwrites the placeholder, so
    // the real credential never enters the container.
    const env = composeAnthropicEnv('https://api.anthropic.com', {});
    expect(env.ANTHROPIC_BASE_URL).toBe('https://api.anthropic.com');
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('placeholder');
  });

  it('threads the managed-fleet gateway token through verbatim', () => {
    // Regression: the OneCLI 2.x credential model stopped rewriting the
    // placeholder bearer for a link-local gateway, so the container must
    // present the real gateway sentinel itself or the gateway answers
    // `401 No credentials config`.
    const env = composeAnthropicEnv('http://169.254.169.254/gateway/llm/anthropic', {
      NANOCLAW_ANTHROPIC_AUTH_TOKEN: 'exedev-gateway-no-auth',
    });
    expect(env.ANTHROPIC_BASE_URL).toBe('http://169.254.169.254/gateway/llm/anthropic');
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('exedev-gateway-no-auth');
  });

  it('trims surrounding whitespace on the fleet token', () => {
    const env = composeAnthropicEnv('http://169.254.169.254/gateway/llm/anthropic', {
      NANOCLAW_ANTHROPIC_AUTH_TOKEN: '  exedev-gateway-no-auth  ',
    });
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('exedev-gateway-no-auth');
  });

  it('falls back to the placeholder for a blank fleet token', () => {
    const env = composeAnthropicEnv('http://169.254.169.254/gateway/llm/anthropic', {
      NANOCLAW_ANTHROPIC_AUTH_TOKEN: '   ',
    });
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('placeholder');
  });
});
