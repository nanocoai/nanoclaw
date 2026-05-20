---
name: olx-research
description: Research OLX.uz marketplace — analyze competitors, pricing, ad patterns in target category. Builds strategy for ad placement based on market data and platform rules. Use when planning OLX.uz ad campaigns or analyzing competition before ad creation.
---

# OLX.uz Market Research & Strategy

Analyze OLX.uz marketplace to build data-driven ad strategy. Feeds findings into olx-ad-generator.

## Trigger

"исследуй olx", "конкуренты на olx", "olx research", "анализ рынка olx", "стратегия для olx"

## Prerequisites

- `agent-browser` for live OLX.uz browsing
- Target category/niche from user
- Client data from wiki (recommended — feeds into gap analysis):
  - `wiki/entities/<client>.md` — profile, services, USP
  - `wiki/entities/<client>-funnel-strategy.md` — audience, positioning
  - `wiki/entities/brand-<client>.md` — visual style for competitor comparison

## Workflow

### Phase 1: Define Search Parameters

Ask user (or extract from client profile):
- **Niche/category:** IT курсы, SMM, маркетинг, etc.
- **Location:** Ташкент, вся Узбекистан, конкретный район
- **Target audience:** студенты, предприниматели, фрилансеры

Map to OLX.uz category tree:
```
Услуги > Образование / курсы / репетиторство / спорт > IT курсы
Услуги > Образование / курсы / репетиторство / спорт > Другие услуги образования
Бизнес и услуги > Маркетинговые услуги
```

### Phase 2: Competitor Scan

Browse OLX.uz target category via agent-browser:

```bash
agent-browser open "https://www.olx.uz/uslugi/obrazovanie/"
agent-browser wait --timeout 5000
agent-browser snapshot -i
```

For each competitor ad (collect 10-20):
1. Open ad page, screenshot
2. Extract: title, price, description (first 500 chars), photo count, seller type, location
3. Note: language (RU/UZ/mixed), formatting style, keywords used

Also search by keywords relevant to client's niche:
```bash
agent-browser open "https://www.olx.uz/list/q-SMM-курсы/"
agent-browser snapshot -i
```

Search variations: "{нейросети курсы}", "{AI обучение}", "{маркетинг курсы}", "{таргет обучение}"

### Phase 3: Competitor Analysis

For top 5-10 competitors, extract:

| Field | What to look for |
|-------|-----------------|
| Title patterns | Keywords, length, bilingual (RU+UZ), specific tools mentioned |
| Pricing | Range, "договорная" vs fixed, comparison to market |
| Description | Structure, selling points, tone, call-to-action |
| Photos | Quality, text overlays, infographics, count |
| Category | Which subcategory, cross-posting |
| Seller | Private vs business, rating, activity |

### Phase 4: Gap Analysis

Read client data from wiki (client-profile, funnel-strategy) to compare offering vs competitors:

```
Client USP (from wiki):
- [unique features from client-profile]
- [audience from funnel-strategy]

Strengths we can leverage:
- [what client has that competitors don't]

Gaps in the market:
- [categories with few ads, underserved topics]

Competitor weaknesses:
- [poor photos, vague descriptions, high prices]

Keyword opportunities:
- [terms competitors use that we should include]
- [terms nobody uses but audience searches for]
```

### Phase 5: Build Strategy

Output a strategy document with:

1. **Recommended category** — where to post (primary + secondary if rules allow)
2. **Positioning** — how to differentiate from competitors
3. **Price strategy** — fixed price vs "договорная", competitive range
4. **Keyword strategy** — top keywords from competitor analysis
5. **Visual strategy** — what type of images work in this category
6. **Language** — RU only, UZ only, or bilingual
7. **Timing** — when to post/refresh (30-day cycle)
8. **Number of ads** — how many different angles (within OLX rules)

### Phase 6: Save to Wiki

```bash
export CLIENT="<client-name>"
export DATE=$(date +%Y-%m-%d)
cat > /workspace/group/wiki/entities/${CLIENT}-olx-strategy.md << 'EOF'
# OLX.uz Strategy: <client>
Date: <date>
Category: <category>
...strategy content...
EOF
```

Append to wiki log:
```
## [DATE] research | OLX.uz market research for <client>: <category>, <N> competitors analyzed
```

## Output

Deliver to user:
```
📊 OLX.uz Market Research: <category>
━━━━━━━━━━━━━━━━━━━━━━━━━
🔍 Проанализировано: <N> объявлений конкурентов
💰 Ценовой диапазон: <min> - <max> сум
📝 Топ-ключевые слова: <keyword1>, <keyword2>, ...
📸 Фото: в среднем <N>/8 у конкурентов
🏆 Главное преимущество: <differentiation>

📋 Стратегия сохранена в wiki.
Готово к генерации объявлений → olx-ad-generator
```

## Platform Rules Reference

Read `/workspace/group/wiki/entities/olx-uz-platform.md` for full moderation rules before building strategy. Key constraints:
- No income promises
- No MLM/partner recruitment
- No external links
- No fake prices
- Max 70 char titles, ~9000 char descriptions, 8 photos
