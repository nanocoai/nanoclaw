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
