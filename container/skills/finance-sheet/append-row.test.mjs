import { describe, it, expect, vi } from 'vitest';
import { run } from './append-row.mjs';

function fakeFiles() {
  const sa = JSON.stringify({
    client_email: 'sa@proj.iam.gserviceaccount.com',
    private_key: '-----BEGIN PRIVATE KEY-----\nFAKE\n-----END PRIVATE KEY-----\n',
  });
  const cfg = JSON.stringify({ sheetId: 'SHEET123', tab: 'Lançamentos' });
  return (p) => {
    if (p.endsWith('sheets-sa.json')) return sa;
    if (p.endsWith('finance.json')) return cfg;
    throw new Error(`unexpected read ${p}`);
  };
}

describe('run', () => {
  it('mints a token then appends the row and returns updatedRange', async () => {
    const calls = [];
    const fetchImpl = vi.fn(async (url, opts) => {
      calls.push({ url, opts });
      if (url === 'https://oauth2.googleapis.com/token') {
        return { ok: true, json: async () => ({ access_token: 'tok_abc' }) };
      }
      return {
        ok: true,
        json: async () => ({ updates: { updatedRange: 'Lançamentos!A2:E2' } }),
      };
    });

    const res = await run({
      argv: ['--valor', '50.00', '--descricao', 'Almoço',
             '--categoria', 'Alimentação', '--forma', 'Cartão',
             '--data', '27/06/2026'],
      readFileSync: fakeFiles(),
      fetchImpl,
      now: 1_700_000_000,
      buildAssertion: () => 'fake.jwt.assertion',
    });

    expect(res).toEqual({ ok: true, updatedRange: 'Lançamentos!A2:E2' });
    expect(calls[0].url).toBe('https://oauth2.googleapis.com/token');
    expect(calls[0].opts.body).toContain('grant_type=urn');
    expect(calls[1].url).toBe(
      'https://sheets.googleapis.com/v4/spreadsheets/SHEET123/values/Lan%C3%A7amentos!A:E:append?valueInputOption=USER_ENTERED',
    );
    expect(calls[1].opts.headers.Authorization).toBe('Bearer tok_abc');
    expect(JSON.parse(calls[1].opts.body)).toEqual({
      values: [['27/06/2026', '50.00', 'Almoço', 'Alimentação', 'Cartão']],
    });
  });

  it('throws a readable error when the token endpoint fails', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 401,
      text: async () => 'invalid_grant',
    }));
    await expect(
      run({
        argv: ['--valor', '10'],
        readFileSync: fakeFiles(),
        fetchImpl,
        now: 1_700_000_000,
        buildAssertion: () => 'fake.jwt.assertion',
      }),
    ).rejects.toThrow('Falha ao obter token (401): invalid_grant');
  });
});
