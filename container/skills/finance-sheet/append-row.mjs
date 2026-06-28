import { readFileSync as fsReadFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseArgs, buildJwtAssertion, buildAppendBody } from './sheets.mjs';

const SA_PATH = process.env.SA_PATH || '/workspace/group/.config/sheets-sa.json';
const FINANCE_CONFIG =
  process.env.FINANCE_CONFIG || '/workspace/group/.config/finance.json';

/**
 * Append one financial entry to the configured Google Sheet.
 * Dependencies (fs, fetch, clock, JWT builder) are injectable for testing.
 */
export async function run({
  argv,
  readFileSync = fsReadFileSync,
  fetchImpl = fetch,
  now = Math.floor(Date.now() / 1000),
  buildAssertion = buildJwtAssertion,
} = {}) {
  const fields = parseArgs(argv);

  let sa;
  try {
    sa = JSON.parse(readFileSync(SA_PATH, 'utf-8'));
  } catch {
    throw new Error(`Service account ausente em ${SA_PATH}`);
  }
  let cfg;
  try {
    cfg = JSON.parse(readFileSync(FINANCE_CONFIG, 'utf-8'));
  } catch {
    throw new Error(`Config ausente em ${FINANCE_CONFIG}`);
  }
  if (!cfg.sheetId || !cfg.tab) {
    throw new Error('finance.json precisa de "sheetId" e "tab"');
  }

  const assertion = buildAssertion({
    clientEmail: sa.client_email,
    privateKey: sa.private_key,
    now,
  });

  const tokenRes = await fetchImpl('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:
      'grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer' +
      `&assertion=${encodeURIComponent(assertion)}`,
  });
  if (!tokenRes.ok) {
    const detail = await tokenRes.text();
    throw new Error(`Falha ao obter token (${tokenRes.status}): ${detail}`);
  }
  const { access_token: accessToken } = await tokenRes.json();

  // Encode only the tab name; keep the A1 range operators (!, :) literal.
  const range = `${encodeURIComponent(cfg.tab)}!A:E`;
  const url =
    `https://sheets.googleapis.com/v4/spreadsheets/${cfg.sheetId}` +
    `/values/${range}:append?valueInputOption=USER_ENTERED`;

  const appendRes = await fetchImpl(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(buildAppendBody(fields)),
  });
  if (!appendRes.ok) {
    const detail = await appendRes.text();
    throw new Error(`Falha ao gravar (${appendRes.status}): ${detail}`);
  }
  const body = await appendRes.json();
  return { ok: true, updatedRange: body.updates?.updatedRange };
}

// CLI entry: run when invoked directly, not when imported by tests.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run({ argv: process.argv.slice(2) })
    .then((r) => {
      console.log(`OK ${r.updatedRange ?? ''}`.trim());
      process.exit(0);
    })
    .catch((err) => {
      console.error(err.message);
      process.exit(1);
    });
}
