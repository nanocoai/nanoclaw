import { readFileSync as fsReadFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import {
  parseDeleteArgs,
  buildJwtAssertion,
  loadServiceAccount,
  loadConfig,
  getAccessToken,
  normalizeValor,
  buildDeleteRequest,
} from './sheets.mjs';

const SA_PATH = process.env.SA_PATH || '/workspace/group/.config/sheets-sa.json';
const FINANCE_CONFIG =
  process.env.FINANCE_CONFIG || '/workspace/group/.config/finance.json';

const SHEETS = 'https://sheets.googleapis.com/v4/spreadsheets';

/** GET the numeric gid for cfg.tab, or throw if the tab is absent. */
async function resolveGid({ fetchImpl, accessToken, cfg }) {
  const url = `${SHEETS}/${cfg.sheetId}?fields=sheets(properties(sheetId,title))`;
  const res = await fetchImpl(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Falha ao ler metadados (${res.status}): ${detail}`);
  }
  const body = await res.json();
  const match = (body.sheets || []).find(
    (s) => s.properties?.title === cfg.tab,
  );
  if (!match) throw new Error(`Aba "${cfg.tab}" não encontrada na planilha`);
  return match.properties.sheetId;
}

/** Re-read the target row and throw if it no longer matches --expect-*. */
async function verifyRow({ fetchImpl, accessToken, cfg, row, expectValor, expectDescricao }) {
  if (!expectValor && !expectDescricao) return;
  const range = `${encodeURIComponent(cfg.tab)}!A${row}:E${row}`;
  const res = await fetchImpl(`${SHEETS}/${cfg.sheetId}/values/${range}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Falha ao ler planilha (${res.status}): ${detail}`);
  }
  const body = await res.json();
  const cells = (body.values && body.values[0]) || [];
  const atualValor = cells[1] ?? '';
  const atualDescricao = cells[2] ?? '';
  const valorOk =
    !expectValor || normalizeValor(expectValor) === normalizeValor(atualValor);
  const descOk =
    !expectDescricao ||
    String(atualDescricao).toLowerCase().includes(expectDescricao.toLowerCase());
  if (!valorOk || !descOk) {
    throw new Error(
      `Linha ${row} não confere (esperado valor=${expectValor} descricao=${expectDescricao}, ` +
        `atual valor=${atualValor} descricao=${atualDescricao})`,
    );
  }
}

/**
 * Delete one row from the configured sheet, after verifying it still matches
 * the expected value/description. Deps injectable for testing.
 */
export async function run({
  argv,
  readFileSync = fsReadFileSync,
  fetchImpl = fetch,
  now = Math.floor(Date.now() / 1000),
  buildAssertion = buildJwtAssertion,
} = {}) {
  const { row, expectValor, expectDescricao } = parseDeleteArgs(argv);
  const sa = loadServiceAccount(SA_PATH, readFileSync);
  const cfg = loadConfig(FINANCE_CONFIG, readFileSync);
  const accessToken = await getAccessToken({ sa, fetchImpl, now, buildAssertion });

  const gid = await resolveGid({ fetchImpl, accessToken, cfg });
  await verifyRow({ fetchImpl, accessToken, cfg, row, expectValor, expectDescricao });

  const res = await fetchImpl(`${SHEETS}/${cfg.sheetId}:batchUpdate`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(buildDeleteRequest({ gid, rowNumber: row })),
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Falha ao excluir (${res.status}): ${detail}`);
  }
  return { ok: true, row };
}

// CLI entry: run when invoked directly, not when imported by tests.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run({ argv: process.argv.slice(2) })
    .then(() => {
      console.log('OK');
      process.exit(0);
    })
    .catch((err) => {
      console.error(err.message);
      process.exit(1);
    });
}
