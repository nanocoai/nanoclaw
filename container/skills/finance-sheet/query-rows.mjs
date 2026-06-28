import { readFileSync as fsReadFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import {
  parseQueryArgs,
  buildJwtAssertion,
  loadServiceAccount,
  loadConfig,
  getAccessToken,
  valuesToRows,
  rowMatches,
} from './sheets.mjs';

const SA_PATH = process.env.SA_PATH || '/workspace/group/.config/sheets-sa.json';
const FINANCE_CONFIG =
  process.env.FINANCE_CONFIG || '/workspace/group/.config/finance.json';

/**
 * Read the sheet and return data rows (1-based row numbers) matching the
 * optional --valor/--descricao/--data filters. Deps injectable for testing.
 */
export async function run({
  argv,
  readFileSync = fsReadFileSync,
  fetchImpl = fetch,
  now = Math.floor(Date.now() / 1000),
  buildAssertion = buildJwtAssertion,
} = {}) {
  const filters = parseQueryArgs(argv);
  const sa = loadServiceAccount(SA_PATH, readFileSync);
  const cfg = loadConfig(FINANCE_CONFIG, readFileSync);
  const accessToken = await getAccessToken({ sa, fetchImpl, now, buildAssertion });

  const range = `${encodeURIComponent(cfg.tab)}!A:E`;
  const url =
    `https://sheets.googleapis.com/v4/spreadsheets/${cfg.sheetId}/values/${range}`;
  const res = await fetchImpl(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Falha ao ler planilha (${res.status}): ${detail}`);
  }
  const body = await res.json();
  const rows = valuesToRows(body.values).filter((r) => rowMatches(r, filters));
  return { ok: true, rows };
}

// CLI entry: run when invoked directly, not when imported by tests.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run({ argv: process.argv.slice(2) })
    .then((r) => {
      console.log(JSON.stringify(r.rows));
      process.exit(0);
    })
    .catch((err) => {
      console.error(err.message);
      process.exit(1);
    });
}
