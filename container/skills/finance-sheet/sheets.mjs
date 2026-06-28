import crypto from 'node:crypto';

/** Base64url-encode a string or Buffer (no padding, URL-safe alphabet). */
export function base64url(input) {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/** Parse --flag value pairs into the entry fields. Throws if valor is absent. */
export function parseArgs(argv) {
  const out = { data: '', valor: '', descricao: '', categoria: '', forma: '' };
  const keys = {
    '--data': 'data',
    '--valor': 'valor',
    '--descricao': 'descricao',
    '--categoria': 'categoria',
    '--forma': 'forma',
  };
  for (let i = 0; i < argv.length; i += 2) {
    const key = keys[argv[i]];
    if (key) out[key] = argv[i + 1] ?? '';
  }
  if (!out.valor) throw new Error('Valor é obrigatório');
  return out;
}

/** Build a signed RS256 JWT assertion for the Google token endpoint. */
export function buildJwtAssertion({ clientEmail, privateKey, now }) {
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = base64url(
    JSON.stringify({
      iss: clientEmail,
      scope: 'https://www.googleapis.com/auth/spreadsheets',
      aud: 'https://oauth2.googleapis.com/token',
      iat: now,
      exp: now + 3600,
    }),
  );
  const signingInput = `${header}.${claims}`;
  const signature = crypto.sign(
    'RSA-SHA256',
    Buffer.from(signingInput),
    privateKey,
  );
  return `${signingInput}.${base64url(signature)}`;
}

/** Build the Sheets values.append request body (column order is fixed). */
export function buildAppendBody({ data, valor, descricao, categoria, forma }) {
  return { values: [[data, valor, descricao, categoria, forma]] };
}
