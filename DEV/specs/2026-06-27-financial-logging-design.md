# Lançamentos financeiros no Google Sheets — Design / Spec

- **Data:** 2026-06-27
- **Status:** Aprovado (design) — aguardando revisão do spec antes do plano
- **Escopo:** Permitir que o ted (NanoClaw no Telegram) registre lançamentos financeiros numa planilha do Google Sheets a partir de mensagens em **texto e imagem**. Áudio fica para uma fase posterior.

---

## 1. Contexto e restrições

NanoClaw roda no Coolify (ver `DEV/specs/2026-06-27-coolify-deploy-design.md`). O agente Claude executa em containers efêmeros, com working dir `/workspace/group` (= `groups/main/`, montado read-write). Fatos relevantes confirmados no código:

- O canal Telegram (`src/channels/telegram.ts`) já baixa anexos (foto/voz/áudio/documento) para `groups/<grupo>/attachments/` e entrega o **caminho** ao agente como texto (ex.: `[Image] (/workspace/group/attachments/photo_123.jpg) <caption>`).
- O Claude é multimodal nativo: lê texto e **imagens** diretamente (via tool Read). Áudio NÃO é processado nativamente — exige transcrição (fora de escopo no MVP).
- `container/skills/*` são **sincronizados automaticamente** para `~/.claude/skills/` de cada grupo a cada container (`src/container-runner.ts`), ficando disponíveis ao agente como skills do Claude Code.
- A imagem do agente (`container/Dockerfile`) é `node:22-slim` → tem Node disponível para scripts.
- O credential proxy (porta 3001) cobre apenas a API da Anthropic; o container tem egress de internet normal e alcança `*.googleapis.com` e `oauth2.googleapis.com` diretamente.
- Segredos do host (`.env`) são "sombreados" (montados como `/dev/null`) no container; portanto a credencial do Google NÃO pode chegar via `.env`/env vars — precisa ser um arquivo no group folder.

## 2. Decisões de design (aprovadas)

- **Backend:** Google Sheets.
- **Entrada:** texto + imagem no MVP; áudio depois.
- **Campos por lançamento:** `Data`, `Valor`, `Descrição`, `Categoria`, `Forma de pagamento`.
- **Fluxo:** o ted extrai os campos, grava na planilha e **confirma** (não pede aprovação prévia).
- **Escrita:** skill de container + **service account** do Google Cloud.

## 3. Arquitetura

```
Telegram (texto/imagem)
  └─> canal já baixa anexos + entrega caminho/texto ao agente
        └─> ted (Claude Agent SDK em /workspace/group)
              ├─ instruções: groups/main/CLAUDE.md (comportamento de lançamento)
              └─ skill de container: finance-sheet
                    └─ append-row.mjs (Node puro)
                          ├─ lê groups/main/.config/sheets-sa.json (service account)
                          ├─ lê groups/main/.config/finance.json (SHEET_ID, aba)
                          ├─ JWT RS256 (node:crypto) -> access token (oauth2.googleapis.com)
                          └─ POST values:append -> Google Sheets API
```

## 4. Componentes

### 4.1 Comportamento do ted — `groups/main/CLAUDE.md`
Adiciona uma seção "Lançamentos financeiros" instruindo o ted a:
- Reconhecer mensagens que descrevem um gasto/receita (texto livre ou imagem de nota/comprovante).
- Extrair os 5 campos. Regras: `Data` = hoje (timezone `America/Sao_Paulo`) se não informada; normalizar `Valor` para número com 2 casas; escolher `Categoria` de uma lista padrão (Alimentação, Transporte, Moradia, Saúde, Lazer, Compras, Serviços, Receita, Outros); inferir `Forma de pagamento` quando citada (Cartão, Pix, Dinheiro, Boleto, Transferência), senão deixar vazio.
- Para imagens: ler o arquivo do anexo e extrair os campos do comprovante.
- Chamar a skill `finance-sheet` para gravar.
- Confirmar no formato: `✅ Lancei: R$ 50,00 · Almoço · Alimentação · Cartão · 27/06`.
- Pedir esclarecimento APENAS quando faltar o `Valor` (campo crítico). Demais campos podem ficar inferidos/vazios.

### 4.2 Skill de container — `container/skills/finance-sheet/`
- `SKILL.md`: frontmatter (`name: finance-sheet`, `description`, `allowed-tools: Bash(node:*)`) + instruções de uso e o formato de chamada do script.
- `append-row.mjs`: script Node sem dependências externas. Responsabilidades:
  - Ler caminho do service account e config via constantes (`/workspace/group/.config/sheets-sa.json`, `/workspace/group/.config/finance.json`).
  - Aceitar os campos por flags CLI: `--data`, `--valor`, `--descricao`, `--categoria`, `--forma`.
  - Montar JWT RS256 (claim `scope=https://www.googleapis.com/auth/spreadsheets`, `aud=https://oauth2.googleapis.com/token`) assinado com a chave privada do SA (`crypto.sign`).
  - Trocar o JWT por access token em `https://oauth2.googleapis.com/token`.
  - `POST https://sheets.googleapis.com/v4/spreadsheets/{SHEET_ID}/values/{ABA}!A:E:append?valueInputOption=USER_ENTERED` com a linha `[Data, Valor, Descrição, Categoria, Forma]`.
  - Sucesso: imprime `OK <range atualizado>` e sai 0. Falha: imprime erro legível em stderr e sai ≠ 0.

### 4.3 Configuração no group folder (fora do git)
- `groups/main/.config/sheets-sa.json` — chave JSON do service account.
- `groups/main/.config/finance.json` — `{ "sheetId": "<id>", "tab": "Lançamentos" }`.
- Garantir que `groups/` permanece no `.gitignore` (ou ao menos `groups/**/.config/`), para a credencial nunca ir ao repositório.

## 5. Setup do Google (uma vez, manual)
1. Google Cloud: criar projeto, ativar **Google Sheets API**, criar **service account**, gerar **chave JSON**.
2. Criar a planilha com a aba `Lançamentos` e cabeçalho na linha 1: `Data | Valor | Descrição | Categoria | Forma de pagamento`.
3. Compartilhar a planilha como **Editor** com o e-mail do service account (`...@...iam.gserviceaccount.com`).
4. Copiar `sheets-sa.json` e criar `finance.json` em `groups/main/.config/` no servidor (via Terminal do Coolify).

## 6. Fluxo de dados (exemplo)
1. Você manda "gastei 50 no almoço no cartão".
2. ted extrai: Data=hoje, Valor=50.00, Descrição="Almoço", Categoria="Alimentação", Forma="Cartão".
3. ted roda `node ~/.claude/skills/finance-sheet/append-row.mjs --data 27/06/2026 --valor 50.00 --descricao "Almoço" --categoria "Alimentação" --forma "Cartão"`.
4. Script grava a linha e retorna OK.
5. ted responde `✅ Lancei: R$ 50,00 · Almoço · Alimentação · Cartão · 27/06`.

## 7. Tratamento de erros
- Credencial/config ausente: script sai ≠ 0 com mensagem indicando o arquivo faltante; ted avisa que o registro financeiro não está configurado.
- Falha de API (rede/permissão/sheet errado): script sai ≠ 0 com o status; ted responde que **não conseguiu gravar** e ecoa o lançamento tentado, para você reenviar/corrigir. Nenhum dado é perdido silenciosamente.
- Falta o `Valor`: ted não chama o script; pergunta o valor.

## 8. Testes
- **Unit (host repo, vitest):** parsing/uso de flags e construção do payload do `append-row.mjs` podem ser testados extraindo a montagem da linha numa função pura (sem rede). Mock do fetch para validar o endpoint/headers/body montados. JWT: validar que a assinatura usa a chave e os claims corretos (com uma chave de teste).
- **Manual E2E:** com o SA e a planilha de teste configurados, rodar o script com valores fixos e conferir a linha na planilha; depois, mensagem real no Telegram → linha gravada → confirmação.

## 9. Critérios de sucesso
- Mensagem de texto descrevendo um gasto → linha correta na planilha + confirmação no formato definido.
- Imagem de comprovante → campos extraídos e linha gravada.
- Falha de gravação → ted avisa e ecoa o lançamento (sem perda).
- A credencial do service account nunca aparece no repositório git.

## 10. Fora de escopo
- Áudio / transcrição (fase 2).
- Edição/remoção de lançamentos já gravados, relatórios, somatórios e dashboards.
- Múltiplos grupos/planilhas (apenas o chat main por enquanto).
- Categorização automática avançada / regras fiscais.
