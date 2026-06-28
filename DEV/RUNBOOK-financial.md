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

# 3. Permissões: o agente roda como o usuário `node` (uid 1000), NÃO root.
#    Os arquivos precisam ser legíveis por ele — use 644 (não 600/root-only):
chmod 644 /app/groups/main/.config/sheets-sa.json /app/groups/main/.config/finance.json
```

> Esses arquivos ficam no volume `nanoclaw-groups` (persistem entre deploys) e nunca vão ao git.
> ⚠️ Não use `chmod 600`: o Terminal do Coolify roda como root, mas o container do agente roda como `node` (uid 1000) e não conseguiria ler uma chave `600` de dono root — o ted reportaria "Service account ausente".

## C. Deploy do código

O código da skill (`container/skills/finance-sheet/`) ships pela imagem. Após push da branch `deploy/coolify`, faça **Redeploy** no Coolify (rebuild da imagem do host). A skill é sincronizada para o agente automaticamente no próximo container.

## D. Verificação

1. Teste o script direto no servidor (Terminal do Coolify). Como isso roda no
   container host, aponte os caminhos para `/app/groups/main/.config/`:
   ```bash
   cd /app && \
   SA_PATH=/app/groups/main/.config/sheets-sa.json \
   FINANCE_CONFIG=/app/groups/main/.config/finance.json \
   TZ=America/Sao_Paulo node container/skills/finance-sheet/append-row.mjs \
     --data "$(TZ=America/Sao_Paulo date +%d/%m/%Y)" --valor "1.23" \
     --descricao "Teste setup" --categoria "Outros" --forma "Pix"
   ```
   Esperado: `OK Lançamentos!A<n>:E<n>` e uma linha nova na planilha. Apague a linha de teste depois.
   (No container do agente, em mensagens reais do Telegram, os caminhos padrão
   `/workspace/group/.config/` já funcionam sem sobrescrever.)
2. No Telegram, mande ao ted: `gastei 50 no almoço no cartão`.
   Esperado: linha gravada + resposta `✅ Lancei: R$ 50,00 · Almoço · Alimentação · Cartão · <DD/MM>`.
3. Mande uma foto de um comprovante. Esperado: campos extraídos + linha gravada + confirmação.

## Troubleshooting
- `Service account ausente` / `Config ausente`: arquivos não estão em `/app/groups/main/.config/`. Refaça a seção B.
- `Falha ao obter token (401): invalid_grant`: relógio do servidor torto ou chave inválida — confira o JSON do SA.
- `Falha ao gravar (403)`: a planilha não foi compartilhada com o e-mail do service account (seção A.3).
- `Falha ao gravar (404)`: `sheetId` errado em `finance.json`.
- ted não tenta gravar: a skill pode não ter sincronizado — confirme o redeploy e que `container/skills/finance-sheet/` está na imagem.
