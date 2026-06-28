---
name: finance-sheet
description: Registrar e excluir lançamentos financeiros (gastos e receitas) numa planilha do Google Sheets. Use ao relatar um gasto/compra/pagamento/recebimento — por texto ou imagem (ex.: "gastei 50 no almoço", foto de cupom) — E ao pedir explicitamente para excluir/apagar/remover um lançamento já registrado (ex.: "exclui o lançamento de 50 do almoço").
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

3. **Excluir** a linha escolhida, passando o `row` e os valores atuais como guarda de segurança. Em `--expect-valor`/`--expect-descricao` use **exatamente** o valor e a descrição **completos** daquela linha (copie do JSON do passo 1, não uma versão abreviada) — é o que impede excluir a linha errada caso a planilha tenha mudado:

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
