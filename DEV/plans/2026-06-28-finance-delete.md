# Finance Delete Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the agent delete a financial entry from the Google Sheet on explicit request, after locating it by value/description/date and confirming with the user.

**Architecture:** Extend the existing `finance-sheet` skill. Shared auth/config helpers move into `sheets.mjs`. A new `query-rows.mjs` reads and filters rows (returns 1-based row numbers as JSON); a new `delete-row.mjs` re-verifies the row then removes it via the Sheets `batchUpdate` `DeleteDimensionRequest` (shift-up). `append-row.mjs` is refactored to reuse the shared helpers. SKILL.md gains a confirm-before-delete flow.

**Tech Stack:** Node.js ESM (`.mjs`), built-in `node:crypto`/`fetch`, Google Sheets API v4, vitest with dependency injection (`fetchImpl`, `readFileSync`, `now`, `buildAssertion`).

## Global Constraints

- Language of all user-facing strings and skill instructions: **Portuguese (pt-BR)**, matching existing SKILL.md/append-row.mjs.
- Column order is fixed: `Data | Valor | Descrição | Categoria | Forma de pagamento` (A:E). Row 1 is a header and is **never** deletable.
- Default paths: `SA_PATH = /workspace/group/.config/sheets-sa.json`, `FINANCE_CONFIG = /workspace/group/.config/finance.json` (overridable via env, same as `append-row.mjs`).
- JWT scope stays `https://www.googleapis.com/auth/spreadsheets`. No credential, config, mount, or permission changes.
- All scripts: CLI entry guarded by `if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)`; success → `console.log` + `exit(0)`; error → `console.error(err.message)` + `exit(1)`.
- Tests are vitest, files named `*.test.mjs`, run with `npx vitest run container/skills/finance-sheet`. Dependencies injected, never real network/fs.
- Value comparison is **numeric** (normalize `R$`, thousands separators, comma→dot, `parseFloat`), never string equality.
- `allowed-tools` in SKILL.md stays `Bash(node:*)`.

---

## Task 1: Shared helpers in `sheets.mjs` (auth + config + numeric value)

Extract reusable auth/config from `append-row.mjs` and add the value-normalization helper. No behavior change yet for append — Task 2 rewires it.

**Files:**
- Modify: `container/skills/finance-sheet/sheets.mjs`
- Test: `container/skills/finance-sheet/sheets.test.mjs`

**Interfaces:**
- Consumes: existing `buildJwtAssertion` (unchanged).
- Produces:
  - `loadServiceAccount(path, readFileSync) -> { client_email, private_key, ... }` — throws `Service account ausente em <path>` on read/parse failure.
  - `loadConfig(path, readFileSync) -> { sheetId, tab }` — throws `Config ausente em <path>` on read/parse failure; throws `finance.json precisa de "sheetId" e "tab"` if either missing.
  - `getAccessToken({ sa, fetchImpl, now, buildAssertion }) -> Promise<string>` — POSTs the JWT grant to `https://oauth2.googleapis.com/token`; throws `Falha ao obter token (<status>): <body>` on non-ok.
  - `normalizeValor(s) -> number | null` — `null` for empty/unparseable; strips `R$`, spaces, thousands dots; comma→dot; `parseFloat`.

- [ ] **Step 1: Write the failing tests**

Append to `container/skills/finance-sheet/sheets.test.mjs` (keep existing imports; add the new names to the import from `./sheets.mjs`):

```javascript
import {
  base64url,
  parseArgs,
  buildJwtAssertion,
  buildAppendBody,
  loadServiceAccount,
  loadConfig,
  getAccessToken,
  normalizeValor,
} from './sheets.mjs';

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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run container/skills/finance-sheet/sheets.test.mjs`
Expected: FAIL — `loadServiceAccount`/`loadConfig`/`getAccessToken`/`normalizeValor` are not exported (import error or `is not a function`).

- [ ] **Step 3: Add the helpers to `sheets.mjs`**

Append to `container/skills/finance-sheet/sheets.mjs`:

```javascript
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run container/skills/finance-sheet/sheets.test.mjs`
Expected: PASS (existing 6 + new tests).

- [ ] **Step 5: Commit**

```bash
git add container/skills/finance-sheet/sheets.mjs container/skills/finance-sheet/sheets.test.mjs
git commit -m "feat(finance): shared auth/config + numeric value helpers in sheets.mjs"
```

---

## Task 2: Rewire `append-row.mjs` to use the shared helpers

Behavior unchanged; remove the now-duplicated auth/config code.

**Files:**
- Modify: `container/skills/finance-sheet/append-row.mjs:1-77`
- Test: `container/skills/finance-sheet/append-row.test.mjs` (existing tests must stay green; no test changes required)

**Interfaces:**
- Consumes: `loadServiceAccount`, `loadConfig`, `getAccessToken`, `buildAppendBody`, `parseArgs` from `./sheets.mjs`.
- Produces: `run({ argv, readFileSync, fetchImpl, now, buildAssertion }) -> { ok: true, updatedRange }` (signature unchanged).

- [ ] **Step 1: Run existing tests to confirm green baseline**

Run: `npx vitest run container/skills/finance-sheet/append-row.test.mjs`
Expected: PASS (2 tests).

- [ ] **Step 2: Replace the body of `append-row.mjs`**

Replace lines 1–77 (imports through end of `run`) with:

```javascript
import { readFileSync as fsReadFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import {
  parseArgs,
  buildJwtAssertion,
  buildAppendBody,
  loadServiceAccount,
  loadConfig,
  getAccessToken,
} from './sheets.mjs';

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
  const sa = loadServiceAccount(SA_PATH, readFileSync);
  const cfg = loadConfig(FINANCE_CONFIG, readFileSync);
  const accessToken = await getAccessToken({ sa, fetchImpl, now, buildAssertion });

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
```

Keep the existing CLI entry block (lines 79–90) unchanged.

- [ ] **Step 3: Run tests to verify still green**

Run: `npx vitest run container/skills/finance-sheet/append-row.test.mjs`
Expected: PASS (2 tests, unchanged behavior). The `Falha ao obter token (401)` test still passes because `getAccessToken` throws the same message.

- [ ] **Step 4: Commit**

```bash
git add container/skills/finance-sheet/append-row.mjs
git commit -m "refactor(finance): append-row uses shared sheets.mjs helpers"
```

---

## Task 3: Row parsing, matching, and request builders in `sheets.mjs`

Pure functions for the query/delete scripts. No network.

**Files:**
- Modify: `container/skills/finance-sheet/sheets.mjs`
- Test: `container/skills/finance-sheet/sheets.test.mjs`

**Interfaces:**
- Consumes: `normalizeValor` (Task 1).
- Produces:
  - `parseQueryArgs(argv) -> { valor, descricao, data }` — all optional, default `''`.
  - `parseDeleteArgs(argv) -> { row, expectValor, expectDescricao }` — `row` is an integer; throws `--row é obrigatório` if absent, `--row deve ser um inteiro >= 2 (linha 1 é cabeçalho)` if `< 2` or non-integer. `expectValor`/`expectDescricao` default `''`.
  - `valuesToRows(values) -> Array<{ row, data, valor, descricao, categoria, forma }>` — `values` is the Sheets `values` array (row 1 = header); returns data rows only, `row` is 1-based spreadsheet row (so first data row is `2`). Missing cells default to `''`.
  - `rowMatches(row, { valor, descricao, data }) -> boolean` — empty filter fields are ignored (AND of provided filters). `valor`: numeric equality via `normalizeValor` (both sides; if filter normalizes to null, that filter is skipped). `descricao`: case-insensitive substring. `data`: case-insensitive substring.
  - `buildDeleteRequest({ gid, rowNumber }) -> object` — `batchUpdate` body with one `DeleteDimensionRequest` (ROWS, `startIndex: rowNumber - 1`, `endIndex: rowNumber`).

- [ ] **Step 1: Write the failing tests**

Append to `container/skills/finance-sheet/sheets.test.mjs` (add the four new names to the existing `./sheets.mjs` import):

```javascript
// add to the import: parseQueryArgs, parseDeleteArgs, valuesToRows, rowMatches, buildDeleteRequest

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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run container/skills/finance-sheet/sheets.test.mjs`
Expected: FAIL — new exports undefined.

- [ ] **Step 3: Add the functions to `sheets.mjs`**

Append to `container/skills/finance-sheet/sheets.mjs`:

```javascript
/** Parse optional query filters. */
export function parseQueryArgs(argv) {
  const out = { valor: '', descricao: '', data: '' };
  const keys = { '--valor': 'valor', '--descricao': 'descricao', '--data': 'data' };
  for (let i = 0; i < argv.length; i += 2) {
    const key = keys[argv[i]];
    if (key) out[key] = argv[i + 1] ?? '';
  }
  return out;
}

/** Parse delete args: required --row (>=2 integer) + optional --expect-*. */
export function parseDeleteArgs(argv) {
  const out = { row: undefined, expectValor: '', expectDescricao: '' };
  const keys = {
    '--row': 'row',
    '--expect-valor': 'expectValor',
    '--expect-descricao': 'expectDescricao',
  };
  for (let i = 0; i < argv.length; i += 2) {
    const key = keys[argv[i]];
    if (key) out[key] = argv[i + 1] ?? '';
  }
  if (out.row === undefined) throw new Error('--row é obrigatório');
  const n = Number(out.row);
  if (!Number.isInteger(n) || n < 2) {
    throw new Error('--row deve ser um inteiro >= 2 (linha 1 é cabeçalho)');
  }
  out.row = n;
  return out;
}

/** Map a Sheets values matrix to data rows with 1-based row numbers. */
export function valuesToRows(values) {
  if (!Array.isArray(values)) return [];
  const rows = [];
  for (let i = 1; i < values.length; i += 1) {
    const v = values[i] || [];
    rows.push({
      row: i + 1,
      data: v[0] ?? '',
      valor: v[1] ?? '',
      descricao: v[2] ?? '',
      categoria: v[3] ?? '',
      forma: v[4] ?? '',
    });
  }
  return rows;
}

/** True if the row satisfies every provided (non-empty) filter. */
export function rowMatches(row, { valor, descricao, data }) {
  if (valor) {
    const want = normalizeValor(valor);
    if (want !== null) {
      const got = normalizeValor(row.valor);
      if (got === null || got !== want) return false;
    }
  }
  if (descricao && !String(row.descricao).toLowerCase().includes(descricao.toLowerCase())) {
    return false;
  }
  if (data && !String(row.data).toLowerCase().includes(data.toLowerCase())) {
    return false;
  }
  return true;
}

/** Build the batchUpdate body that removes one row (shift-up). */
export function buildDeleteRequest({ gid, rowNumber }) {
  return {
    requests: [
      {
        deleteDimension: {
          range: {
            sheetId: gid,
            dimension: 'ROWS',
            startIndex: rowNumber - 1,
            endIndex: rowNumber,
          },
        },
      },
    ],
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run container/skills/finance-sheet/sheets.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add container/skills/finance-sheet/sheets.mjs container/skills/finance-sheet/sheets.test.mjs
git commit -m "feat(finance): row parse/match + delete-request builders"
```

---

## Task 4: `query-rows.mjs` — read and filter rows

**Files:**
- Create: `container/skills/finance-sheet/query-rows.mjs`
- Test: `container/skills/finance-sheet/query-rows.test.mjs`

**Interfaces:**
- Consumes: `parseQueryArgs`, `loadServiceAccount`, `loadConfig`, `getAccessToken`, `valuesToRows`, `rowMatches`, `buildJwtAssertion` from `./sheets.mjs`.
- Produces: `run({ argv, readFileSync, fetchImpl, now, buildAssertion }) -> { ok: true, rows: Array<{row,data,valor,descricao,categoria,forma}> }`. CLI prints `JSON.stringify(rows)`.

- [ ] **Step 1: Write the failing test**

Create `container/skills/finance-sheet/query-rows.test.mjs`:

```javascript
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run container/skills/finance-sheet/query-rows.test.mjs`
Expected: FAIL — `query-rows.mjs` does not exist.

- [ ] **Step 3: Create `query-rows.mjs`**

```javascript
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run container/skills/finance-sheet/query-rows.test.mjs`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add container/skills/finance-sheet/query-rows.mjs container/skills/finance-sheet/query-rows.test.mjs
git commit -m "feat(finance): query-rows reads and filters spreadsheet rows"
```

---

## Task 5: `delete-row.mjs` — re-verify then delete

**Files:**
- Create: `container/skills/finance-sheet/delete-row.mjs`
- Test: `container/skills/finance-sheet/delete-row.test.mjs`

**Interfaces:**
- Consumes: `parseDeleteArgs`, `loadServiceAccount`, `loadConfig`, `getAccessToken`, `normalizeValor`, `buildDeleteRequest`, `buildJwtAssertion` from `./sheets.mjs`.
- Produces: `run({ argv, readFileSync, fetchImpl, now, buildAssertion }) -> { ok: true, row }`.

**Flow inside `run`:** auth → resolve gid (`GET .../spreadsheets/{sheetId}?fields=sheets(properties(sheetId,title))`, match `title === cfg.tab`) → re-verify guard (`GET .../values/{tab}!A{row}:E{row}`, compare against `--expect-*`) → `POST .../spreadsheets/{sheetId}:batchUpdate` with `buildDeleteRequest`.

Error strings:
- gid not found: `Aba "<tab>" não encontrada na planilha`.
- expect mismatch: `Linha <row> não confere (esperado valor=<v> descricao=<d>, atual valor=<av> descricao=<ad>)`.
- batchUpdate failure: `Falha ao excluir (<status>): <body>`.
- metadata read failure: `Falha ao ler metadados (<status>): <body>`.

- [ ] **Step 1: Write the failing test**

Create `container/skills/finance-sheet/delete-row.test.mjs`:

```javascript
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run container/skills/finance-sheet/delete-row.test.mjs`
Expected: FAIL — `delete-row.mjs` does not exist.

- [ ] **Step 3: Create `delete-row.mjs`**

```javascript
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run container/skills/finance-sheet/delete-row.test.mjs`
Expected: PASS (4 tests).

- [ ] **Step 5: Run the whole finance suite**

Run: `npx vitest run container/skills/finance-sheet`
Expected: PASS (all files: sheets, append-row, query-rows, delete-row).

- [ ] **Step 6: Commit**

```bash
git add container/skills/finance-sheet/delete-row.mjs container/skills/finance-sheet/delete-row.test.mjs
git commit -m "feat(finance): delete-row verifies then removes a row via batchUpdate"
```

---

## Task 6: SKILL.md — confirm-before-delete flow

**Files:**
- Modify: `container/skills/finance-sheet/SKILL.md`

**Interfaces:**
- Consumes: `query-rows.mjs` and `delete-row.mjs` CLI contracts from Tasks 4–5.
- Produces: agent-facing instructions (no code).

- [ ] **Step 1: Update the frontmatter `description`**

Replace the `description:` line (line 3) with:

```yaml
description: Registrar e excluir lançamentos financeiros (gastos e receitas) numa planilha do Google Sheets. Use ao relatar um gasto/compra/pagamento/recebimento — por texto ou imagem (ex.: "gastei 50 no almoço", foto de cupom) — E ao pedir explicitamente para excluir/apagar/remover um lançamento já registrado (ex.: "exclui o lançamento de 50 do almoço").
```

- [ ] **Step 2: Replace the "Não faça" section with delete instructions**

Replace lines 39–42 (the `## Não faça` block) with:

````markdown
## Excluir lançamento

Só exclua quando o usuário pedir **explicitamente** (ex.: "exclui/apaga/remove o lançamento de…"). Nunca exclua por conta própria.

1. **Buscar.** Extraia os critérios da mensagem (valor, descrição e/ou data) e liste as linhas que batem:

   ```bash
   node ~/.claude/skills/finance-sheet/query-rows.mjs \
     --valor "50.00" --descricao "almoço"
   ```

   Saída: JSON com `[{ "row": 2, "data": "...", "valor": "...", "descricao": "...", "categoria": "...", "forma": "..." }, ...]`. Os filtros são opcionais — sem nenhum, retorna todas as linhas (faça o casamento você mesmo lendo o JSON).

2. **Decidir e confirmar:**
   - **0 linhas** → diga que não encontrou nenhum lançamento com esses dados.
   - **1 linha** → mostre-a e peça confirmação: `Achei: R$ 50,00 · Almoço · 27/06. Confirma excluir?` Só prossiga após um "sim" claro.
   - **Várias linhas** → liste-as numeradas (com data/valor/descrição) e peça para o usuário escolher qual. Confirme a escolha.

3. **Excluir** a linha escolhida, passando o `row` e os valores atuais como guarda de segurança:

   ```bash
   node ~/.claude/skills/finance-sheet/delete-row.mjs \
     --row 2 --expect-valor "50.00" --expect-descricao "Almoço"
   ```

   - Código 0 → excluiu. Confirme: `🗑️ Excluí: R$ 50,00 · Almoço · 27/06`.
   - Código ≠ 0 → NÃO excluiu (imprime o erro). Se a mensagem citar `não confere`, a linha mudou desde a busca — refaça a busca antes de tentar de novo. Avise o usuário.

## Não faça

- Não exclua sem o usuário pedir explicitamente e sem confirmar a linha exata.
- Não exclua a linha 1 (cabeçalho).
- Não edite/atualize lançamentos (só adicionar e excluir).
- Não invente valor: se não há valor num lançamento novo, pergunte.
````

- [ ] **Step 3: Sanity-check the file**

Run: `head -5 container/skills/finance-sheet/SKILL.md && echo '---' && grep -n "delete-row\|query-rows\|Excluir" container/skills/finance-sheet/SKILL.md`
Expected: frontmatter `description` mentions excluir; both script names present; an `## Excluir lançamento` heading exists.

- [ ] **Step 4: Commit**

```bash
git add container/skills/finance-sheet/SKILL.md
git commit -m "docs(finance): SKILL confirm-before-delete flow for entries"
```

---

## Task 7: RUNBOOK note

**Files:**
- Modify: `DEV/RUNBOOK-financial.md`

- [ ] **Step 1: Append a short note**

Add at the end of `DEV/RUNBOOK-financial.md`:

```markdown

## Exclusão de lançamentos

A skill `finance-sheet` também exclui lançamentos quando o usuário pede explicitamente (`query-rows.mjs` localiza, `delete-row.mjs` remove via `batchUpdate`). Usa a **mesma** service account e scope (`.../auth/spreadsheets`) — nenhuma credencial, permissão ou config adicional é necessária.
```

- [ ] **Step 2: Commit**

```bash
git add DEV/RUNBOOK-financial.md
git commit -m "docs(finance): runbook note on entry deletion"
```

---

## Final verification

- [ ] **Run the full finance suite once more**

Run: `npx vitest run container/skills/finance-sheet`
Expected: PASS — all of sheets / append-row / query-rows / delete-row.

- [ ] **Confirm no other code paths reference the old inline append auth**

Run: `grep -rn "oauth2.googleapis.com/token" container/skills/finance-sheet/*.mjs`
Expected: only `sheets.mjs` contains the token URL (append/query/delete go through `getAccessToken`).
