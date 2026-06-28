import { describe, it, expect, vi } from 'vitest';
import { run } from './query-rows.mjs';

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

const SHEET_VALUES = [
  ['Data', 'Valor', 'Descrição', 'Categoria', 'Forma'],
  ['27/06/2026', '50.00', 'Almoço', 'Alimentação', 'Cartão'],
  ['27/06/2026', '12.00', 'Uber', 'Transporte', 'Pix'],
  ['28/06/2026', '50', 'Almoço executivo', 'Alimentação', 'Cartão'],
];

function fetchOk() {
  return vi.fn(async (url) => {
    if (url === 'https://oauth2.googleapis.com/token') {
      return { ok: true, json: async () => ({ access_token: 'tok' }) };
    }
    return { ok: true, json: async () => ({ values: SHEET_VALUES }) };
  });
}

describe('query-rows run', () => {
  it('reads the A:E range and returns all data rows when unfiltered', async () => {
    const fetchImpl = fetchOk();
    const res = await run({
      argv: [],
      readFileSync: fakeFiles(),
      fetchImpl,
      now: 1,
      buildAssertion: () => 'j',
    });
    expect(res.ok).toBe(true);
    expect(res.rows.map((r) => r.row)).toEqual([2, 3, 4]);
    const valuesUrl = fetchImpl.mock.calls[1][0];
    expect(valuesUrl).toBe(
      'https://sheets.googleapis.com/v4/spreadsheets/SHEET123/values/Lan%C3%A7amentos!A:E',
    );
  });

  it('filters by numeric valor and descricao substring', async () => {
    const res = await run({
      argv: ['--valor', 'R$ 50,00', '--descricao', 'almoço'],
      readFileSync: fakeFiles(),
      fetchImpl: fetchOk(),
      now: 1,
      buildAssertion: () => 'j',
    });
    expect(res.rows.map((r) => r.row)).toEqual([2, 4]); // both "almoço" rows = 50
  });

  it('throws a readable error when the values read fails', async () => {
    const fetchImpl = vi.fn(async (url) => {
      if (url === 'https://oauth2.googleapis.com/token') {
        return { ok: true, json: async () => ({ access_token: 'tok' }) };
      }
      return { ok: false, status: 403, text: async () => 'forbidden' };
    });
    await expect(
      run({ argv: [], readFileSync: fakeFiles(), fetchImpl, now: 1, buildAssertion: () => 'j' }),
    ).rejects.toThrow('Falha ao ler planilha (403): forbidden');
  });
});
