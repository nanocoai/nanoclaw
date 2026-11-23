import { describe, expect, it } from 'vitest';

import { storedAccountId, stubNeedsAccountId, withAccountId, withoutPlanClaim } from './onecli-chatgpt-stub.js';

const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
const claims = (token: string) => JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());

// Shape of OneCLI 1.42's buildCodexOAuthStub output.
const stub = (accountId = 'onecli-managed') =>
  JSON.stringify(
    {
      auth_mode: 'chatgpt',
      OPENAI_API_KEY: null,
      tokens: {
        id_token: `${encode({ alg: 'HS256' })}.${encode({
          sub: 'onecli-managed',
          'https://api.openai.com/auth': {
            chatgpt_plan_type: 'free',
            chatgpt_user_id: 'onecli-managed',
            chatgpt_account_id: accountId,
          },
        })}.c2ln`,
        access_token: 'onecli-managed',
        refresh_token: 'onecli-managed',
        account_id: accountId,
      },
      last_refresh: '2026-10-19T00:00:00.000Z',
    },
    null,
    2,
  );

describe('OneCLI ChatGPT login stand-in', () => {
  it('detects only the fixed-id ChatGPT stand-in', () => {
    expect(stubNeedsAccountId(stub())).toBe(true);
    expect(stubNeedsAccountId(stub('real-workspace'))).toBe(false);
    expect(stubNeedsAccountId(JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: 'onecli-managed' }))).toBe(false);
    expect(stubNeedsAccountId('not json')).toBe(false);
  });

  it('writes the workspace id into the account field and the id token claim, tokens untouched', () => {
    const out = JSON.parse(withAccountId(stub(), 'ws-1234_abcd'));
    expect(out.tokens.account_id).toBe('ws-1234_abcd');
    expect(claims(out.tokens.id_token)['https://api.openai.com/auth']).toEqual({
      chatgpt_plan_type: 'free',
      chatgpt_user_id: 'onecli-managed',
      chatgpt_account_id: 'ws-1234_abcd',
    });
    expect(out.tokens.id_token.split('.')[2]).toBe('c2ln');
    expect(out.tokens.access_token).toBe('onecli-managed');
    expect(out.tokens.refresh_token).toBe('onecli-managed');
    expect(out.last_refresh).toBe('2026-10-19T00:00:00.000Z');
  });

  it('leaves other content and malformed ids unchanged', () => {
    const apiKey = JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: 'onecli-managed' });
    expect(withAccountId(apiKey, 'ws-1')).toBe(apiKey);
    expect(withAccountId('plain', 'ws-1')).toBe('plain');
    expect(withAccountId(stub(), 'bad id\n')).toBe(stub());
    expect(withAccountId(stub(), '')).toBe(stub());
  });

  it('keeps an unreadable id token as written', () => {
    const auth = JSON.parse(stub());
    auth.tokens.id_token = 'a.!!!.c';
    const out = JSON.parse(withAccountId(JSON.stringify(auth), 'ws-1'));
    expect(out.tokens.account_id).toBe('ws-1');
    expect(out.tokens.id_token).toBe('a.!!!.c');
  });

  it("drops the stand-in's made-up plan claim and keeps everything else", () => {
    const out = JSON.parse(withoutPlanClaim(withAccountId(stub(), 'ws-1')));
    expect(claims(out.tokens.id_token)).toEqual({
      sub: 'onecli-managed',
      'https://api.openai.com/auth': { chatgpt_user_id: 'onecli-managed', chatgpt_account_id: 'ws-1' },
    });
    expect(out.tokens.id_token.split('.')[2]).toBe('c2ln');
    expect(out.tokens.access_token).toBe('onecli-managed');
    expect(out.tokens.account_id).toBe('ws-1');
    expect(out.last_refresh).toBe('2026-10-19T00:00:00.000Z');
  });

  it('keeps plan claims it did not make up, and other content, unchanged', () => {
    const real = JSON.parse(stub());
    real.tokens.id_token = `${encode({ alg: 'HS256' })}.${encode({
      'https://api.openai.com/auth': { chatgpt_plan_type: 'plus', chatgpt_user_id: 'user-1' },
    })}.c2ln`;
    const unreadable = JSON.parse(stub());
    unreadable.tokens.id_token = 'a.!!!.c';
    for (const content of [
      JSON.stringify(real),
      JSON.stringify(unreadable),
      JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: 'onecli-managed' }),
      'plain',
    ]) {
      expect(withoutPlanClaim(content)).toBe(content);
    }
  });

  it('returns the stored id only when every stored ChatGPT login names the same one', () => {
    const login = (accountId: unknown) => ({ type: 'openai', metadata: { authMode: 'oauth', accountId } });
    expect(storedAccountId([login('ws-1'), { type: 'anthropic', metadata: { authMode: 'oauth' } }])).toEqual({
      accountId: 'ws-1',
      logins: 1,
    });
    expect(storedAccountId([login('ws-1'), login('ws-1')])).toEqual({ accountId: 'ws-1', logins: 2 });
    expect(storedAccountId([login('ws-1'), login('ws-2')])).toEqual({ logins: 2 });
    // A login without metadata may be the agent's; never substitute another login's workspace.
    expect(storedAccountId([login('ws-1'), login(null)])).toEqual({ logins: 2 });
    expect(storedAccountId([login('bad id')])).toEqual({ logins: 1 });
    expect(storedAccountId([{ type: 'openai', metadata: { authMode: 'api-key' } }])).toEqual({ logins: 0 });
    expect(storedAccountId({ data: [] })).toEqual({ logins: 0 });
  });
});
