import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import {
  base64url,
  parseArgs,
  buildJwtAssertion,
  buildAppendBody,
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
