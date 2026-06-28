# Financial Logging (Google Sheets) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Permitir que o ted registre lançamentos financeiros (Data, Valor, Descrição, Categoria, Forma de pagamento) numa planilha do Google Sheets a partir de mensagens de texto e imagem no Telegram, gravando via service account e confirmando cada lançamento.

**Architecture:** Uma skill de container (`container/skills/finance-sheet/`) que ships pelo git/imagem e é sincronizada automaticamente para `~/.claude/skills/` de cada grupo. A SKILL.md carrega TODO o comportamento (extração, categorias, formato da confirmação, erros) — não depende do `groups/main/CLAUDE.md`, que no servidor é um volume separado. Um script Node puro (`append-row.mjs`) monta um JWT RS256 do service account, troca por access token e dá `append` na planilha via REST da Sheets API. Credenciais ficam em `groups/main/.config/` (volume, fora do git).

**Tech Stack:** Node 22 (ESM `.mjs`, `node:crypto`, global `fetch` — ambos presentes na imagem do agente `node:22-slim`), Google Sheets REST API v4, OAuth2 service account (JWT bearer), vitest (testes no host).

## Global Constraints

- Script roda DENTRO do container do agente (cwd `/workspace/group`), em Node 22 ESM puro, **sem dependências npm** (só `node:crypto` + `fetch`).
- Credenciais nunca no git: a chave do service account fica em `groups/main/.config/sheets-sa.json` e a config em `groups/main/.config/finance.json` (ambos cobertos por `.gitignore` que ignora `groups/main/*` exceto `CLAUDE.md`).
- Caminhos fixos no container: SA em `/workspace/group/.config/sheets-sa.json`, config em `/workspace/group/.config/finance.json` (sobrescrevíveis via env para teste).
- Campos e ordem da linha: `[Data, Valor, Descrição, Categoria, Forma de pagamento]`.
- Categorias padrão: Alimentação, Transporte, Moradia, Saúde, Lazer, Compras, Serviços, Receita, Outros.
- Forma de pagamento: Cartão, Pix, Dinheiro, Boleto, Transferência (ou vazio).
- Confirmação ao usuário: `✅ Lancei: R$ <valor> · <descrição> · <categoria> · <forma> · <DD/MM>`.
- Append endpoint: `POST https://sheets.googleapis.com/v4/spreadsheets/{SHEET_ID}/values/{TAB}!A:E:append?valueInputOption=USER_ENTERED`.
- Token endpoint: `POST https://oauth2.googleapis.com/token` (grant `urn:ietf:params:oauth:grant-type:jwt-bearer`).
- Escopo OAuth: `https://www.googleapis.com/auth/spreadsheets`.
- Testes no host rodam via `npm test` (vitest). O include precisa cobrir `container/skills/**/*.test.mjs`.
- Pedir esclarecimento só quando faltar `Valor`; demais campos podem ser inferidos/vazios.
- Trabalho na branch `deploy/coolify` (mesma do deploy). Push e redeploy têm GATE (confirmação do usuário).

---

## Mapa de arquivos

- Create: `container/skills/finance-sheet/sheets.mjs` — helpers puros (sem I/O): parse de args, JWT, body do append.
- Create: `container/skills/finance-sheet/append-row.mjs` — orquestração: lê config, mints token, faz append. Função `run()` injetável + guarda de CLI.
- Create: `container/skills/finance-sheet/sheets.test.mjs` — testes dos helpers puros (host).
- Create: `container/skills/finance-sheet/append-row.test.mjs` — testes da orquestração com fetch/fs mockados (host).
- Create: `container/skills/finance-sheet/SKILL.md` — comportamento + uso + invocação do script.
- Create: `container/skills/finance-sheet/finance.example.json` — exemplo de config (sem segredos), documenta o formato.
- Modify: `vitest.config.ts` — adicionar `container/skills/**/*.test.mjs` ao include.
- Modify: `groups/main/CLAUDE.md` — persona `ted` + ponteiro curto para a skill (commitado no repo).
- Create: `DEV/RUNBOOK-financial.md` — guia de setup do Google Cloud + colocação dos arquivos no servidor + redeploy + verificação.

---

### Task 1: Helpers puros (`sheets.mjs`)

**Files:**
- Create: `container/skills/finance-sheet/sheets.mjs`
- Test: `container/skills/finance-sheet/sheets.test.mjs`
- Modify: `vitest.config.ts`

**Interfaces:**
- Produces:
  - `base64url(input)` → string (input: string|Buffer)
  - `parseArgs(argv)` → `{ data, valor, descricao, categoria, forma }` (throws `Error('Valor é obrigatório')` se `--valor` ausente/vazio)
  - `buildJwtAssertion({ clientEmail, privateKey, now })` → string (JWT RS256 assinado; `now` em segundos epoch)
  - `buildAppendBody({ data, valor, descricao, categoria, forma })` → `{ values: [[data, valor, descricao, categoria, forma]] }`

- [ ] **Step 1: Add vitest include for container skill tests**

Edit `vitest.config.ts` to:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'src/**/*.test.ts',
      'setup/**/*.test.ts',
      'container/skills/**/*.test.mjs',
    ],
  },
});
```

- [ ] **Step 2: Write the failing tests**

Create `container/skills/finance-sheet/sheets.test.mjs`:

```js
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
    // signature verifies against the public key
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
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run container/skills/finance-sheet/sheets.test.mjs`
Expected: FAIL — `Cannot find module './sheets.mjs'`.

- [ ] **Step 4: Implement `sheets.mjs`**

Create `container/skills/finance-sheet/sheets.mjs`:

```js
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
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run container/skills/finance-sheet/sheets.test.mjs`
Expected: PASS (all cases).

- [ ] **Step 6: Commit**

```bash
git add container/skills/finance-sheet/sheets.mjs container/skills/finance-sheet/sheets.test.mjs vitest.config.ts
git commit -m "feat(finance): pure helpers for Sheets append (JWT, args, body)"
```

---

### Task 2: Orquestração (`append-row.mjs`)

**Files:**
- Create: `container/skills/finance-sheet/append-row.mjs`
- Test: `container/skills/finance-sheet/append-row.test.mjs`

**Interfaces:**
- Consumes: `parseArgs`, `buildJwtAssertion`, `buildAppendBody` from `./sheets.mjs`.
- Produces: `async run({ argv, readFileSync, fetchImpl, now })` → `{ ok: true, updatedRange }`. Throws `Error` com mensagem legível em falhas. Lê SA de `process.env.SA_PATH || '/workspace/group/.config/sheets-sa.json'` e config de `process.env.FINANCE_CONFIG || '/workspace/group/.config/finance.json'`.

- [ ] **Step 1: Write the failing tests**

Create `container/skills/finance-sheet/append-row.test.mjs`:

```js
import { describe, it, expect, vi } from 'vitest';
import { run } from './append-row.mjs';

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

describe('run', () => {
  it('mints a token then appends the row and returns updatedRange', async () => {
    const calls = [];
    const fetchImpl = vi.fn(async (url, opts) => {
      calls.push({ url, opts });
      if (url === 'https://oauth2.googleapis.com/token') {
        return { ok: true, json: async () => ({ access_token: 'tok_abc' }) };
      }
      return {
        ok: true,
        json: async () => ({ updates: { updatedRange: 'Lançamentos!A2:E2' } }),
      };
    });

    const res = await run({
      argv: ['--valor', '50.00', '--descricao', 'Almoço',
             '--categoria', 'Alimentação', '--forma', 'Cartão',
             '--data', '27/06/2026'],
      readFileSync: fakeFiles(),
      fetchImpl,
      now: 1_700_000_000,
    });

    expect(res).toEqual({ ok: true, updatedRange: 'Lançamentos!A2:E2' });
    // token request
    expect(calls[0].url).toBe('https://oauth2.googleapis.com/token');
    expect(calls[0].opts.body).toContain('grant_type=urn');
    // append request: correct sheet, tab range, value option, auth header, body
    expect(calls[1].url).toBe(
      'https://sheets.googleapis.com/v4/spreadsheets/SHEET123/values/Lan%C3%A7amentos!A:E:append?valueInputOption=USER_ENTERED',
    );
    expect(calls[1].opts.headers.Authorization).toBe('Bearer tok_abc');
    expect(JSON.parse(calls[1].opts.body)).toEqual({
      values: [['27/06/2026', '50.00', 'Almoço', 'Alimentação', 'Cartão']],
    });
  });

  it('throws a readable error when the token endpoint fails', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 401,
      text: async () => 'invalid_grant',
    }));
    await expect(
      run({
        argv: ['--valor', '10'],
        readFileSync: fakeFiles(),
        fetchImpl,
        now: 1_700_000_000,
      }),
    ).rejects.toThrow('Falha ao obter token (401): invalid_grant');
  });
});
```

> Nota: `buildJwtAssertion` é chamado com a `private_key` falsa. Para o teste não falhar na assinatura, `run()` deve aceitar a key como está e a assinatura só ocorre dentro de `buildJwtAssertion`. A chave `FAKE` faria `crypto.sign` lançar. Portanto o teste mocka a assinatura injetando `signAssertion`. Ajuste a interface: `run` aceita opcional `buildAssertion` (default = real). Reescreva os dois testes para passar `buildAssertion: () => 'fake.jwt.assertion'`.

Adicione `buildAssertion: () => 'fake.jwt.assertion'` ao objeto passado em ambos os `run({...})` dos testes acima.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run container/skills/finance-sheet/append-row.test.mjs`
Expected: FAIL — `Cannot find module './append-row.mjs'`.

- [ ] **Step 3: Implement `append-row.mjs`**

Create `container/skills/finance-sheet/append-row.mjs`:

```js
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

  const range = `${cfg.tab}!A:E`;
  const url =
    `https://sheets.googleapis.com/v4/spreadsheets/${cfg.sheetId}` +
    `/values/${encodeURIComponent(range)}:append?valueInputOption=USER_ENTERED`;

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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run container/skills/finance-sheet/append-row.test.mjs`
Expected: PASS (both cases). The append URL encodes `Lançamentos` as `Lan%C3%A7amentos`.

- [ ] **Step 5: Run the full suite (regression)**

Run: `npm test`
Expected: all suites pass (273 prior + new finance tests).

- [ ] **Step 6: Commit**

```bash
git add container/skills/finance-sheet/append-row.mjs container/skills/finance-sheet/append-row.test.mjs
git commit -m "feat(finance): append-row orchestration (token + Sheets append)"
```

---

### Task 3: Skill instructions + config example + persona pointer

**Files:**
- Create: `container/skills/finance-sheet/SKILL.md`
- Create: `container/skills/finance-sheet/finance.example.json`
- Modify: `groups/main/CLAUDE.md`

**Interfaces:**
- Consumes: `append-row.mjs` (invoked via `node ~/.claude/skills/finance-sheet/append-row.mjs <flags>`).

- [ ] **Step 1: Create `SKILL.md`**

Create `container/skills/finance-sheet/SKILL.md`:

````markdown
---
name: finance-sheet
description: Registrar lançamentos financeiros (gastos e receitas) numa planilha do Google Sheets. Use sempre que o usuário relatar um gasto, compra, pagamento ou recebimento — por texto ou imagem de comprovante/nota (ex.: "gastei 50 no almoço", "recebi 2000 de salário", ou uma foto de cupom).
allowed-tools: Bash(node:*)
---

# Lançamento financeiro no Google Sheets

Quando o usuário relata um gasto ou receita (texto ou imagem), extraia os campos e grave na planilha.

## Campos a extrair

| Campo | Regra |
|-------|-------|
| Data | Formato `DD/MM/AAAA`. Se o usuário não disser, use hoje (timezone America/Sao_Paulo — rode `TZ=America/Sao_Paulo date +%d/%m/%Y`). |
| Valor | Número com ponto decimal, 2 casas (ex.: `50.00`). Remova "R$", pontos de milhar e troque vírgula por ponto. **Obrigatório.** |
| Descrição | Curta (ex.: "Almoço", "Uber", "Salário"). |
| Categoria | Uma de: Alimentação, Transporte, Moradia, Saúde, Lazer, Compras, Serviços, Receita, Outros. Escolha a mais provável. |
| Forma de pagamento | Uma de: Cartão, Pix, Dinheiro, Boleto, Transferência. Se não informado, deixe vazio. |

Para **imagens**: leia o arquivo do anexo (o caminho vem na mensagem, ex.: `/workspace/group/attachments/photo_123.jpg`) e extraia valor, data e estabelecimento do comprovante.

Se **faltar o Valor** e você não conseguir inferir, pergunte só o valor. Os demais campos podem ficar inferidos ou vazios — não interrogue o usuário por eles.

## Gravar

Rode (cada campo entre aspas):

```bash
node ~/.claude/skills/finance-sheet/append-row.mjs \
  --data "27/06/2026" --valor "50.00" --descricao "Almoço" \
  --categoria "Alimentação" --forma "Cartão"
```

- Saída `OK <range>` e código 0 → gravou. Confirme ao usuário:
  `✅ Lancei: R$ 50,00 · Almoço · Alimentação · Cartão · 27/06`
- Código ≠ 0 (imprime o erro) → NÃO gravou. Avise o usuário que não conseguiu registrar e ecoe o lançamento que tentou, para ele reenviar. Se o erro citar arquivo ausente (`Service account ausente` / `Config ausente`), diga que o registro financeiro ainda não está configurado.

## Não faça

- Não edite nem apague linhas existentes (apenas adiciona).
- Não invente valor: se não há valor, pergunte.
````

- [ ] **Step 2: Create `finance.example.json`**

Create `container/skills/finance-sheet/finance.example.json`:

```json
{
  "sheetId": "COLE_AQUI_O_ID_DA_PLANILHA",
  "tab": "Lançamentos"
}
```

- [ ] **Step 3: Add persona + pointer to `groups/main/CLAUDE.md`**

In `groups/main/CLAUDE.md`, change the first two lines from:

```markdown
# Andy

You are Andy, a personal assistant. You help with tasks, answer questions, and can schedule reminders.
```

to:

```markdown
# ted

You are ted, a personal assistant. You help with tasks, answer questions, and can schedule reminders.

When the user reports a spend or income (text or receipt image), use the **finance-sheet** skill to log it to the spreadsheet and confirm.
```

- [ ] **Step 4: Verify skill files are well-formed**

Run: `node --check container/skills/finance-sheet/append-row.mjs && node --check container/skills/finance-sheet/sheets.mjs && python3 -c "import json;json.load(open('container/skills/finance-sheet/finance.example.json'))" && echo OK`
Expected: `OK` (syntax valid, example JSON parses).

- [ ] **Step 5: Commit**

```bash
git add container/skills/finance-sheet/SKILL.md container/skills/finance-sheet/finance.example.json groups/main/CLAUDE.md
git commit -m "feat(finance): finance-sheet skill instructions, config example, ted persona"
```

---

### Task 4: Google setup guide + deploy + E2E verification (interativo, GATE)

**Files:**
- Create: `DEV/RUNBOOK-financial.md`

**Pré-requisito (GATE):** push da branch + redeploy no Coolify exigem confirmação do usuário. O usuário executa os passos do Google Cloud (criar projeto/SA, compartilhar planilha) e cola os arquivos no servidor via Terminal do Coolify.

- [ ] **Step 1: Write `DEV/RUNBOOK-financial.md`**

Create `DEV/RUNBOOK-financial.md`:

````markdown
# RUNBOOK — Lançamentos financeiros (Google Sheets)

## A. Setup no Google (uma vez)

### 1. Criar a planilha
1. Crie uma planilha nova no Google Sheets.
2. Renomeie a primeira aba para `Lançamentos`.
3. Na linha 1, coloque os cabeçalhos: `Data | Valor | Descrição | Categoria | Forma de pagamento`.
4. Copie o **ID da planilha** da URL: `https://docs.google.com/spreadsheets/d/<ID>/edit`.

### 2. Criar o service account
1. Acesse https://console.cloud.google.com → crie/seleciona um projeto.
2. **APIs & Services → Library →** procure "Google Sheets API" → **Enable**.
3. **APIs & Services → Credentials → Create Credentials → Service account.** Dê um nome (ex.: `nanoclaw-finance`) → Create → Done.
4. Abra o service account criado → aba **Keys → Add key → Create new key → JSON.** Baixa um arquivo `.json`.
5. Copie o **e-mail** do service account (algo como `nanoclaw-finance@<proj>.iam.gserviceaccount.com`).

### 3. Compartilhar a planilha com o service account
Na planilha → **Share** → cole o e-mail do service account → permissão **Editor** → Send.

## B. Colocar credenciais no servidor (Terminal do Coolify, no recurso nanoclaw)

```bash
mkdir -p /app/groups/main/.config

# 1. Cole o conteúdo do JSON do service account:
cat > /app/groups/main/.config/sheets-sa.json <<'JSON'
<COLE_AQUI_O_CONTEUDO_DO_JSON>
JSON

# 2. Crie a config apontando para a planilha (use o ID copiado em A.1):
cat > /app/groups/main/.config/finance.json <<'JSON'
{ "sheetId": "<ID_DA_PLANILHA>", "tab": "Lançamentos" }
JSON

# 3. Proteja a chave:
chmod 600 /app/groups/main/.config/sheets-sa.json
```

> Esses arquivos ficam no volume `nanoclaw-groups` (persistem entre deploys) e nunca vão ao git.

## C. Deploy do código

O código da skill (`container/skills/finance-sheet/`) ships pela imagem. Após push da branch `deploy/coolify`, faça **Redeploy** no Coolify (rebuild da imagem do host). A skill é sincronizada para o agente automaticamente no próximo container.

## D. Verificação

1. Teste o script direto no servidor (Terminal do Coolify):
   ```bash
   cd /app && TZ=America/Sao_Paulo node container/skills/finance-sheet/append-row.mjs \
     --data "$(TZ=America/Sao_Paulo date +%d/%m/%Y)" --valor "1.23" \
     --descricao "Teste setup" --categoria "Outros" --forma "Pix"
   ```
   Esperado: `OK Lançamentos!A<n>:E<n>` e uma linha nova na planilha. Apague a linha de teste depois.
2. No Telegram, mande ao ted: `gastei 50 no almoço no cartão`.
   Esperado: linha gravada + resposta `✅ Lancei: R$ 50,00 · Almoço · Alimentação · Cartão · <DD/MM>`.
3. Mande uma foto de um comprovante. Esperado: campos extraídos + linha gravada + confirmação.

## Troubleshooting
- `Service account ausente` / `Config ausente`: arquivos não estão em `/app/groups/main/.config/`. Refaça a seção B.
- `Falha ao obter token (401): invalid_grant`: relógio do servidor torto ou chave inválida — confira o JSON do SA.
- `Falha ao gravar (403)`: a planilha não foi compartilhada com o e-mail do service account (seção A.3).
- `Falha ao gravar (404)`: `sheetId` errado em `finance.json`.
- ted não tenta gravar: a skill pode não ter sincronizado — confirme o redeploy e que `container/skills/finance-sheet/` está na imagem.
````

- [ ] **Step 2: Commit the runbook**

```bash
git add DEV/RUNBOOK-financial.md
git commit -m "docs(finance): Google Sheets setup + deploy + verification runbook"
```

- [ ] **Step 3: (GATE) Push and redeploy**

Com autorização do usuário:
```bash
git push origin deploy/coolify
```
Então disparar redeploy via API do Coolify (app `u4fzvrhz676een7jkaj44jli`):
```bash
CT=$(grep -E '^COOLIFY_TOKEN=' .env | cut -d= -f2-)
curl -s -X POST "http://2.24.121.32:8000/api/v1/deploy?uuid=u4fzvrhz676een7jkaj44jli&force=false" -H "Authorization: Bearer $CT"
```
Expected: `{"deployments":[..."queued"...]}`. Aguardar status `finished`.

- [ ] **Step 4: Guiar o usuário pelo setup e verificar**

Conduzir o usuário pelas seções A e B do runbook (Google + colocação no servidor), depois rodar a verificação D. Confirmar a linha na planilha e a resposta do ted no Telegram.

---

## Self-Review (preenchido)

**Spec coverage:**
- §1 entrada texto/imagem já pronta → SKILL.md instrui leitura de anexo (Task 3); nenhuma mudança de canal necessária. ✓
- §2 decisões (campos, fluxo confirma, service account) → Tasks 1-3. ✓
- §4.1 comportamento → movido para SKILL.md (Task 3) + ponteiro no CLAUDE.md (decisão de arquitetura: volume separado no servidor). ✓
- §4.2 skill + append-row.mjs → Tasks 1-3. ✓
- §4.3 config no group folder → caminhos no append-row (Task 2) + finance.example.json (Task 3) + colocação no servidor (Task 4). ✓
- §5 setup Google → RUNBOOK seção A (Task 4). ✓
- §7 erros → run() lança mensagens legíveis + SKILL.md trata saída ≠ 0 (Tasks 2-3). ✓
- §8 testes → sheets.test.mjs + append-row.test.mjs (Tasks 1-2). ✓
- §9 critérios → verificação D (Task 4). ✓

**Placeholder scan:** sem TBD/TODO. Os `<COLE_AQUI...>` no runbook são campos que o usuário preenche no servidor (dados dele), não placeholders de código.

**Type/nome consistency:** `parseArgs`/`buildJwtAssertion`/`buildAppendBody`/`run` e os campos `{data,valor,descricao,categoria,forma}`, caminhos `/workspace/group/.config/{sheets-sa.json,finance.json}`, `sheetId`/`tab`, e o endpoint de append consistentes entre Tasks 1, 2, 3 e o runbook.
