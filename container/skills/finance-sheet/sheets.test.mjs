import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import {
  base64url,
  parseArgs,
  buildJwtAssertion,
  buildAppendBody,
  loadServiceAccount,
  loadConfig,
  getAccessToken,
  normalizeValor,
  parseQueryArgs,
  parseDeleteArgs,
  valuesToRows,
  rowMatches,
  buildDeleteRequest,
} from './sheets.mjs';

describe('base64url', () => {
  it('encodes without padding or +/ chars', () => {
    expect(base64url('subjects?')).toBe('c3ViamVjdHM_');
    expect(base64url(Buffer.from([251, 255]))).toBe('-_8');
  });
});

describe('parseArgs', () => {
  it('parses all flags', () => {
    const args = parseArgs([
      '--data', '27/06/2026',
      '--valor', '50.00',
      '--descricao', 'Almoço',
      '--categoria', 'Alimentação',
      '--forma', 'Cartão',
    ]);
    expect(args).toEqual({
      data: '27/06/2026',
      valor: '50.00',
      descricao: 'Almoço',
      categoria: 'Alimentação',
      forma: 'Cartão',
    });
  });

  it('defaults optional fields to empty string', () => {
    const args = parseArgs(['--valor', '10']);
    expect(args.descricao).toBe('');
    expect(args.categoria).toBe('');
    expect(args.forma).toBe('');
    expect(args.data).toBe('');
  });

  it('throws when valor is missing', () => {
    expect(() => parseArgs(['--descricao', 'x'])).toThrow('Valor é obrigatório');
  });
});

describe('buildAppendBody', () => {
  it('orders columns Data,Valor,Descrição,Categoria,Forma', () => {
    expect(
      buildAppendBody({
        data: '27/06/2026',
        valor: '50.00',
        descricao: 'Almoço',
        categoria: 'Alimentação',
        forma: 'Cartão',
      }),
    ).toEqual({
      values: [['27/06/2026', '50.00', 'Almoço', 'Alimentação', 'Cartão']],
    });
  });
});

describe('buildJwtAssertion', () => {
  it('produces a verifiable RS256 JWT with correct claims', () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
    });
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
    const now = 1_700_000_000;
    const jwt = buildJwtAssertion({
      clientEmail: 'sa@proj.iam.gserviceaccount.com',
      privateKey: pem,
      now,
    });
    const [h, p, s] = jwt.split('.');
    const ok = crypto.verify(
      'RSA-SHA256',
      Buffer.from(`${h}.${p}`),
      publicKey,
      Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64'),
    );
    expect(ok).toBe(true);
    const claims = JSON.parse(Buffer.from(p, 'base64url').toString());
    expect(claims.iss).toBe('sa@proj.iam.gserviceaccount.com');
    expect(claims.scope).toBe('https://www.googleapis.com/auth/spreadsheets');
    expect(claims.aud).toBe('https://oauth2.googleapis.com/token');
    expect(claims.iat).toBe(now);
    expect(claims.exp).toBe(now + 3600);
    const header = JSON.parse(Buffer.from(h, 'base64url').toString());
    expect(header).toEqual({ alg: 'RS256', typ: 'JWT' });
  });
});

describe('normalizeValor', () => {
  it('parses plain and BRL-formatted numbers to a Number', () => {
    expect(normalizeValor('50.00')).toBe(50);
    expect(normalizeValor('50')).toBe(50);
    expect(normalizeValor('R$ 1.234,56')).toBeCloseTo(1234.56, 2);
    expect(normalizeValor('50,00')).toBe(50);
  });
  it('returns null for empty or non-numeric', () => {
    expect(normalizeValor('')).toBeNull();
    expect(normalizeValor('abc')).toBeNull();
  });
});

describe('loadConfig', () => {
  it('returns parsed config', () => {
    const read = () => JSON.stringify({ sheetId: 'S1', tab: 'Lançamentos' });
    expect(loadConfig('/x/finance.json', read)).toEqual({
      sheetId: 'S1',
      tab: 'Lançamentos',
    });
  });
  it('throws when the file is unreadable', () => {
    const read = () => {
      throw new Error('ENOENT');
    };
    expect(() => loadConfig('/x/finance.json', read)).toThrow(
      'Config ausente em /x/finance.json',
    );
  });
  it('throws when sheetId or tab is missing', () => {
    const read = () => JSON.stringify({ sheetId: 'S1' });
    expect(() => loadConfig('/x/finance.json', read)).toThrow(
      'finance.json precisa de "sheetId" e "tab"',
    );
  });
});

describe('loadServiceAccount', () => {
  it('throws a readable error when unreadable', () => {
    const read = () => {
      throw new Error('ENOENT');
    };
    expect(() => loadServiceAccount('/x/sheets-sa.json', read)).toThrow(
      'Service account ausente em /x/sheets-sa.json',
    );
  });
});

describe('getAccessToken', () => {
  it('posts the JWT grant and returns the access_token', async () => {
    const calls = [];
    const fetchImpl = async (url, opts) => {
      calls.push({ url, opts });
      return { ok: true, json: async () => ({ access_token: 'tok_abc' }) };
    };
    const token = await getAccessToken({
      sa: { client_email: 'sa@x.iam', private_key: 'pk' },
      fetchImpl,
      now: 1_700_000_000,
      buildAssertion: () => 'fake.jwt',
    });
    expect(token).toBe('tok_abc');
    expect(calls[0].url).toBe('https://oauth2.googleapis.com/token');
    expect(calls[0].opts.body).toContain('grant_type=urn');
    expect(calls[0].opts.body).toContain('assertion=fake.jwt');
  });
  it('throws with status and body on failure', async () => {
    const fetchImpl = async () => ({
      ok: false,
      status: 401,
      text: async () => 'invalid_grant',
    });
    await expect(
      getAccessToken({
        sa: { client_email: 'sa@x.iam', private_key: 'pk' },
        fetchImpl,
        now: 1,
        buildAssertion: () => 'j',
      }),
    ).rejects.toThrow('Falha ao obter token (401): invalid_grant');
  });
});

describe('parseQueryArgs', () => {
  it('parses provided filters and defaults the rest', () => {
    expect(parseQueryArgs(['--valor', '50', '--descricao', 'almoço'])).toEqual({
      valor: '50',
      descricao: 'almoço',
      data: '',
    });
    expect(parseQueryArgs([])).toEqual({ valor: '', descricao: '', data: '' });
  });
});

describe('parseDeleteArgs', () => {
  it('parses row and expectations', () => {
    expect(
      parseDeleteArgs(['--row', '5', '--expect-valor', '50.00', '--expect-descricao', 'Almoço']),
    ).toEqual({ row: 5, expectValor: '50.00', expectDescricao: 'Almoço' });
  });
  it('throws when --row is missing', () => {
    expect(() => parseDeleteArgs(['--expect-valor', '5'])).toThrow(
      '--row é obrigatório',
    );
  });
  it('throws when --row < 2 or not an integer', () => {
    expect(() => parseDeleteArgs(['--row', '1'])).toThrow(
      '--row deve ser um inteiro >= 2 (linha 1 é cabeçalho)',
    );
    expect(() => parseDeleteArgs(['--row', 'x'])).toThrow(
      '--row deve ser um inteiro >= 2 (linha 1 é cabeçalho)',
    );
  });
});

describe('valuesToRows', () => {
  it('skips the header and returns 1-based row numbers with padded cells', () => {
    const values = [
      ['Data', 'Valor', 'Descrição', 'Categoria', 'Forma'],
      ['27/06/2026', '50.00', 'Almoço', 'Alimentação', 'Cartão'],
      ['28/06/2026', '12'], // short row
    ];
    expect(valuesToRows(values)).toEqual([
      {
        row: 2,
        data: '27/06/2026',
        valor: '50.00',
        descricao: 'Almoço',
        categoria: 'Alimentação',
        forma: 'Cartão',
      },
      {
        row: 3,
        data: '28/06/2026',
        valor: '12',
        descricao: '',
        categoria: '',
        forma: '',
      },
    ]);
  });
  it('returns [] when there is only a header or nothing', () => {
    expect(valuesToRows([['Data', 'Valor']])).toEqual([]);
    expect(valuesToRows([])).toEqual([]);
    expect(valuesToRows(undefined)).toEqual([]);
  });
});

describe('rowMatches', () => {
  const row = {
    row: 2,
    data: '27/06/2026',
    valor: '50.00',
    descricao: 'Almoço no shopping',
    categoria: 'Alimentação',
    forma: 'Cartão',
  };
  it('matches numeric valor regardless of formatting', () => {
    expect(rowMatches(row, { valor: '50', descricao: '', data: '' })).toBe(true);
    expect(rowMatches(row, { valor: 'R$ 50,00', descricao: '', data: '' })).toBe(true);
    expect(rowMatches(row, { valor: '51', descricao: '', data: '' })).toBe(false);
  });
  it('matches descricao as case-insensitive substring', () => {
    expect(rowMatches(row, { valor: '', descricao: 'almoço', data: '' })).toBe(true);
    expect(rowMatches(row, { valor: '', descricao: 'uber', data: '' })).toBe(false);
  });
  it('ANDs provided filters and ignores empty ones', () => {
    expect(rowMatches(row, { valor: '50', descricao: 'almoço', data: '27/06' })).toBe(true);
    expect(rowMatches(row, { valor: '50', descricao: 'uber', data: '' })).toBe(false);
    expect(rowMatches(row, { valor: '', descricao: '', data: '' })).toBe(true);
  });
});

describe('buildDeleteRequest', () => {
  it('builds a DeleteDimensionRequest with 0-based half-open range', () => {
    expect(buildDeleteRequest({ gid: 0, rowNumber: 5 })).toEqual({
      requests: [
        {
          deleteDimension: {
            range: { sheetId: 0, dimension: 'ROWS', startIndex: 4, endIndex: 5 },
          },
        },
      ],
    });
  });
});
