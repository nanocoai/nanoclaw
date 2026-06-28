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

/** Read+parse the service account JSON, with a friendly error. */
export function loadServiceAccount(path, readFileSync) {
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    throw new Error(`Service account ausente em ${path}`);
  }
}

/** Read+parse finance.json, validating required fields. */
export function loadConfig(path, readFileSync) {
  let cfg;
  try {
    cfg = JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    throw new Error(`Config ausente em ${path}`);
  }
  if (!cfg.sheetId || !cfg.tab) {
    throw new Error('finance.json precisa de "sheetId" e "tab"');
  }
  return cfg;
}

/** Exchange a signed JWT for a Google OAuth access token. */
export async function getAccessToken({
  sa,
  fetchImpl,
  now,
  buildAssertion = buildJwtAssertion,
}) {
  const assertion = buildAssertion({
    clientEmail: sa.client_email,
    privateKey: sa.private_key,
    now,
  });
  const res = await fetchImpl('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:
      'grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer' +
      `&assertion=${encodeURIComponent(assertion)}`,
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Falha ao obter token (${res.status}): ${detail}`);
  }
  const { access_token: accessToken } = await res.json();
  return accessToken;
}

/** Normalize a BRL-ish value string to a Number, or null if not numeric. */
export function normalizeValor(s) {
  if (s == null) return null;
  const cleaned = String(s)
    .replace(/R\$/gi, '')
    .replace(/\s/g, '')
    .replace(/\.(?=\d{3}(\D|$))/g, '') // thousands dots
    .replace(',', '.');
  if (cleaned === '') return null;
  const n = Number.parseFloat(cleaned);
  return Number.isNaN(n) ? null : n;
}
