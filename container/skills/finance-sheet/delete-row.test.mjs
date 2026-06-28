import { describe, it, expect, vi } from 'vitest';
import { run } from './delete-row.mjs';

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

// fetch double driven by url; rowValues is what the re-verify GET returns.
function makeFetch({ rowValues, gidTitle = 'Lançamentos', gid = 99 }) {
  return vi.fn(async (url, opts) => {
    if (url === 'https://oauth2.googleapis.com/token') {
      return { ok: true, json: async () => ({ access_token: 'tok' }) };
    }
    if (url.includes('?fields=sheets')) {
      return {
        ok: true,
        json: async () => ({
          sheets: [{ properties: { sheetId: gid, title: gidTitle } }],
        }),
      };
    }
    if (url.includes(':batchUpdate')) {
      return { ok: true, json: async () => ({ replies: [{}] }), opts };
    }
    // values read for the re-verify guard
    return { ok: true, json: async () => ({ values: [rowValues] }) };
  });
}

const baseArgs = ['--row', '3', '--expect-valor', '50.00', '--expect-descricao', 'Almoço'];

describe('delete-row run', () => {
  it('verifies the row then sends a DeleteDimensionRequest with the resolved gid', async () => {
    const fetchImpl = makeFetch({
      rowValues: ['27/06/2026', '50', 'Almoço', 'Alimentação', 'Cartão'],
      gid: 99,
    });
    const res = await run({
      argv: baseArgs,
      readFileSync: fakeFiles(),
      fetchImpl,
      now: 1,
      buildAssertion: () => 'j',
    });
    expect(res).toEqual({ ok: true, row: 3 });
    const batchCall = fetchImpl.mock.calls.find((c) => c[0].includes(':batchUpdate'));
    expect(batchCall[0]).toBe(
      'https://sheets.googleapis.com/v4/spreadsheets/SHEET123:batchUpdate',
    );
    expect(JSON.parse(batchCall[1].body)).toEqual({
      requests: [
        {
          deleteDimension: {
            range: { sheetId: 99, dimension: 'ROWS', startIndex: 2, endIndex: 3 },
          },
        },
      ],
    });
  });

  it('aborts without deleting when the row no longer matches --expect-*', async () => {
    const fetchImpl = makeFetch({
      rowValues: ['27/06/2026', '12', 'Uber', 'Transporte', 'Pix'],
    });
    await expect(
      run({ argv: baseArgs, readFileSync: fakeFiles(), fetchImpl, now: 1, buildAssertion: () => 'j' }),
    ).rejects.toThrow(/Linha 3 não confere/);
    expect(fetchImpl.mock.calls.some((c) => c[0].includes(':batchUpdate'))).toBe(false);
  });

  it('throws when the tab is not found in the spreadsheet', async () => {
    const fetchImpl = makeFetch({
      rowValues: ['27/06/2026', '50', 'Almoço', 'Alimentação', 'Cartão'],
      gidTitle: 'OutraAba',
    });
    await expect(
      run({ argv: baseArgs, readFileSync: fakeFiles(), fetchImpl, now: 1, buildAssertion: () => 'j' }),
    ).rejects.toThrow('Aba "Lançamentos" não encontrada na planilha');
  });

  it('deletes without a guard read when no --expect-* given', async () => {
    const fetchImpl = makeFetch({ rowValues: [], gid: 7 });
    const res = await run({
      argv: ['--row', '4'],
      readFileSync: fakeFiles(),
      fetchImpl,
      now: 1,
      buildAssertion: () => 'j',
    });
    expect(res).toEqual({ ok: true, row: 4 });
    // no values GET when there is nothing to verify
    expect(fetchImpl.mock.calls.some((c) => /\/values\/.*A4:E4/.test(c[0]))).toBe(false);
  });
});
