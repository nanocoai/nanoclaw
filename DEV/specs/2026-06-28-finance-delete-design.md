# Design — Exclusão de lançamentos financeiros

**Data:** 2026-06-28
**Status:** Aprovado (design); pendente plano de implementação
**Relacionado:** [2026-06-27-financial-logging-design.md](2026-06-27-financial-logging-design.md), [../RUNBOOK-financial.md](../RUNBOOK-financial.md)

## Objetivo

Estender a skill `finance-sheet` para que o agente (ted) possa **excluir** lançamentos da planilha do Google Sheets quando o usuário pedir explicitamente, informando critérios como valor, descrição e/ou data. Hoje a skill só adiciona linhas (`append-row.mjs`) e o SKILL.md proíbe explicitamente apagar.

## Princípio central

`append` é cego (só adiciona). `delete` precisa **primeiro localizar a linha certa** a partir do que o usuário descreve — e exclusão é irreversível. Logo, o design prioriza segurança: **sempre confirmar antes de apagar** e **re-verificar** o conteúdo da linha no momento da exclusão.

## Decisões tomadas

1. **Fluxo:** sempre confirmar antes. O agente busca, mostra a(s) linha(s) que batem, e só apaga após o "ok" do usuário. Múltiplos matches → lista numerada para escolha. Zero matches → avisa.
2. **Mecanismo:** apagar a linha de fato com shift-up (`batchUpdate` / `DeleteDimensionRequest`), não limpar conteúdo. Planilha fica sem buracos.
3. **gid da aba:** resolvido em runtime (GET nos metadados da planilha, casando `properties.title == cfg.tab`). Nada novo no `finance.json`.
4. **Auth compartilhada:** extrair `getAccessToken`/`loadConfig`/`loadServiceAccount` para `sheets.mjs`; `append-row.mjs` passa a usar (teste dele atualizado).

## O que NÃO muda

Credenciais, scope do JWT (`.../auth/spreadsheets` já cobre leitura+escrita+batchUpdate), `finance.json`, mounts e permissões. O caminho de `append` continua funcionalmente idêntico.

## Componentes

### `sheets.mjs` (refactor + novos helpers)

Mantém `base64url`, `parseArgs`, `buildJwtAssertion`, `buildAppendBody`. Adiciona:

- `loadServiceAccount(path, readFileSync)` → objeto SA; lança `Service account ausente em <path>`.
- `loadConfig(path, readFileSync)` → cfg; lança `Config ausente em <path>`; valida `sheetId` + `tab`.
- `getAccessToken({ sa, fetchImpl, now, buildAssertion })` → string `access_token`. Encapsula o bloco JWT→token hoje inline em `append-row.mjs` (linhas 44–55).
- `parseDeleteArgs(argv)` → `{ row, expectValor, expectDescricao }` para o `--row`/`--expect-*`. `row` obrigatório e inteiro ≥ 2 (linha 1 é header, nunca apagável).
- `parseQueryArgs(argv)` → `{ valor, descricao, data }` (todos opcionais).
- `rowMatches(row, { valor, descricao, data })` → bool. `valor` = comparação **numérica** (normaliza ambos os lados: remove "R$"/milhar, vírgula→ponto, `parseFloat`) — o Sheets pode devolver `50.00` como `50` ou `50,00`; **nunca comparar valor como string**. `descricao` = substring case-insensitive. `data` = substring (o Sheets pode reformatar datas). Filtros são pré-filtro grosseiro; o agente ainda pode chamar `query-rows.mjs` sem filtros e fazer o casamento fuzzy sobre o JSON.
- `buildDeleteRequest({ gid, rowNumber })` → body do `batchUpdate` com `DeleteDimensionRequest` (ROWS, `startIndex: rowNumber-1`, `endIndex: rowNumber`).

### `query-rows.mjs` (novo — leitura/busca)

CLI entry no mesmo estilo de `append-row.mjs` (DI de `readFileSync`/`fetchImpl`/`now` para teste; guarda `import.meta.url`).

1. `loadServiceAccount` + `loadConfig`.
2. `getAccessToken`.
3. `GET https://sheets.googleapis.com/v4/spreadsheets/{sheetId}/values/{tab}!A:E`.
4. Mapeia cada linha de dados para `{ row: <1-based>, data, valor, descricao, categoria, forma }`, **pulando a linha 1 (header)**.
5. Aplica `rowMatches` com os filtros recebidos (sem filtro → retorna todas).
6. Imprime **JSON** (array) no stdout; código 0. Erro → stderr + código ≠ 0.

`--valor` / `--descricao` / `--data` opcionais.

### `delete-row.mjs` (novo — exclusão)

CLI entry no mesmo estilo.

1. `parseDeleteArgs` (`--row N`, opcionais `--expect-valor` / `--expect-descricao`).
2. `loadServiceAccount` + `loadConfig` + `getAccessToken`.
3. **Guarda de segurança:** `GET .../values/{tab}!A{N}:E{N}`; se `--expect-valor`/`--expect-descricao` foram passados e **não** batem com o conteúdo atual (mesma comparação numérica de valor / substring de descrição do `rowMatches`) → aborta com erro `Linha {N} não confere (esperado ... , atual ...)`, sem apagar. Protege contra deslocamento de índice / planilha alterada entre a busca e a exclusão.
4. Resolve `gid`: `GET .../spreadsheets/{sheetId}?fields=sheets(properties(sheetId,title))`, acha `title == cfg.tab`. Se não achar → erro.
5. `POST .../spreadsheets/{sheetId}:batchUpdate` com `buildDeleteRequest`.
6. Saída `OK` + código 0; erro → mensagem + código ≠ 0.

## Fluxo end-to-end

```
Usuário: "exclui o lançamento de R$50 do almoço"
  → agente extrai critérios (valor 50.00, descrição "almoço", data se houver)
  → node query-rows.mjs --valor 50.00 --descricao almoço
  ├─ 0 matches → "não achei nenhum lançamento de R$50 com 'almoço'"
  ├─ 1 match   → mostra a linha; pergunta "confirma excluir? [data·valor·desc]"
  └─ N matches → lista numerada; usuário escolhe
  → (após confirmação) node delete-row.mjs --row N \
        --expect-valor 50.00 --expect-descricao "Almoço"
       ├─ OK → "🗑️ Excluí: R$ 50,00 · Almoço · 27/06"
       └─ erro → avisa que não excluiu e ecoa o motivo
```

## SKILL.md

- Remover a regra "Não edite nem apague linhas existentes".
- Nova seção **"Excluir lançamento"**: agir **só** com pedido explícito de exclusão; buscar com `query-rows.mjs`; mostrar candidatas; **confirmar**; apagar com `delete-row.mjs` passando `--expect-valor`/`--expect-descricao` da linha escolhida. Nunca apagar sem confirmação; nunca apagar a linha 1 (header).
- `description` do frontmatter: incluir gatilhos de exclusão ("exclua/apaga/remove o lançamento de …").
- `allowed-tools` permanece `Bash(node:*)`.

## Testes

Seguindo o estilo de injeção de dependências de `append-row.test.mjs` / `sheets.test.mjs`:

- `sheets.test.mjs` (acréscimos): `getAccessToken`, `parseDeleteArgs` (rejeita row < 2 / não-inteiro), `parseQueryArgs`, `rowMatches` (valor exato, descrição substring, data), `buildDeleteRequest` (startIndex/endIndex).
- `query-rows.test.mjs`: pula header; filtra corretamente; retorna JSON com `row` 1-based; erro de config/SA.
- `delete-row.test.mjs`: guarda re-verifica e **aborta** quando `--expect-*` não bate; resolução de gid (incl. tab inexistente); monta o `DeleteDimensionRequest` certo; erro do batchUpdate propaga código ≠ 0.
- `append-row.test.mjs`: atualizado para o `append-row.mjs` refatorado (auth via `getAccessToken`), mantendo cobertura.

## RUNBOOK-financial.md

Adendo curto: a skill agora também exclui lançamentos sob pedido explícito; nenhuma mudança de credencial/scope necessária.

## Fora de escopo (YAGNI)

- Editar/atualizar lançamentos existentes (só adicionar e excluir).
- Exclusão em lote / por intervalo de datas.
- Undo / lixeira.
