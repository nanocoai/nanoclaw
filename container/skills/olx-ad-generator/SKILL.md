---
name: olx-ad-generator
description: Generate OLX.uz compliant ads — titles, descriptions, image prompts. Uses client profile, market research, and strict moderation rules. Includes A/B tracking and auto-publish via agent-browser. Use after olx-research or directly with client data from wiki.
---

# OLX.uz Ad Generator

Generate moderation-safe ads for OLX.uz. Integrates with client pipeline (instagram-analyzer → client-profile → funnel-strategist) and design-social-post for visuals.

## Trigger

"создай объявление olx", "olx ad", "объявление для olx", "опубликуй на olx"

## Prerequisites

- OLX platform rules: `wiki/entities/olx-uz-platform.md` — **MUST READ first**
- Client data from wiki (any of: client-profile, instagram analysis, funnel-strategy, brand guide)
- OLX strategy from olx-research — recommended but optional

## Phase 1: Load Context

Read in order, use whatever is available:

```
wiki/entities/olx-uz-platform.md         ← rules & blocklist (REQUIRED)
wiki/entities/<client>-olx-strategy.md    ← research & keywords (if exists)
wiki/entities/<client>.md                 ← client profile: USP, audience, services
wiki/entities/<client>-funnel-strategy.md ← recommended funnels, pricing
wiki/entities/brand-<client>.md           ← colors, tone, style
wiki/media/instagram/<client>/author/     ← photos for banners
```

Extract: service, target audience, differentiators, credentials, keywords, price range.

## Phase 2: Compliance Pre-flight

Before writing ANY copy, read blocklist from `wiki/entities/olx-uz-platform.md` section "ЗАПРЕЩЕНО". Key rules:

**Never include:** income promises ($X/мес, заработок, доход, пассивный доход), partner/MLM/recruitment language, external links/URLs, fake prices, competitor names, ALL CAPS titles, keyword stuffing.

**Safe alternatives:**
- "Востребованная профессия" not "заработок"
- "Научишься создавать..." not "будешь зарабатывать..."
- "Навыки для фриланса" not "$X в месяц"
- "Практический курс" not "бесплатный вебинар" (if there's upsell)
- "Напишите/позвоните" not "перейдите по ссылке"

## Phase 3: Generate Title (max 70 chars)

Generate 3-5 options. Rules:
- Describe WHAT is taught (skill/tool), not earnings
- Include keywords from strategy
- Consider bilingual: "Курс / Kurs"
- "С нуля" is strong for education
- Specific tools attract clicks: "ChatGPT, нейросети, AI"
- Mention city if offline: "в Ташкенте"

Verify each title: `echo -n "TITLE" | wc -c` ≤ 70.

## Phase 4: Generate Description

Pick template matching the service type, fill with client data.

### Template A: Курс / Обучение

```
[HOOK — 2-3 строки, видны в превью. Конкретный навык + для кого.]

═══════════════════════════════
ЧЕМУ ВЫ НАУЧИТЕСЬ:
═══════════════════════════════

[Модуль 1] — [навык + инструмент]
- Практический результат

[Модуль 2] — [навык + инструмент]
- Практический результат

[Модуль 3] — [навык + инструмент]
- Практический результат

═══════════════════════════════
ФОРМАТ ОБУЧЕНИЯ:
═══════════════════════════════

- Формат (онлайн/офлайн/гибрид), кол-во уроков, длительность
- Практика: что получите на выходе
- Язык, поддержка преподавателя

═══════════════════════════════
КОМУ ПОДОЙДЁТ:
═══════════════════════════════

- [Аудитория 1] - [почему]
- [Аудитория 2] - [почему]

═══════════════════════════════
О ПРЕПОДАВАТЕЛЕ:
═══════════════════════════════

[Имя] — [регалии, опыт, компании, social proof без цифр дохода]

═══════════════════════════════
ЧТО ПОЛУЧИТЕ:
═══════════════════════════════

- [Deliverable 1]
- [Deliverable 2]
- [Сертификат - если есть]

═══════════════════════════════

Напишите или позвоните — расскажу подробнее!
```

### Template B: Услуга (SMM, дизайн, разработка)

```
[HOOK — что делаю и для кого, конкретный результат]

═══════════════════════════════
ЧТО Я ДЕЛАЮ:
═══════════════════════════════

- [Услуга 1] - [описание, сроки]
- [Услуга 2] - [описание, сроки]

═══════════════════════════════
КАК ЭТО РАБОТАЕТ:
═══════════════════════════════

1. [Шаг 1 — что от вас нужно]
2. [Шаг 2 — что я делаю]
3. [Шаг 3 — что вы получаете]

═══════════════════════════════
ПОРТФОЛИО / РЕЗУЛЬТАТЫ:
═══════════════════════════════

- [Кейс 1 - без цифр дохода клиента]
- [Кейс 2]

═══════════════════════════════
ОБО МНЕ:
═══════════════════════════════

[Имя, опыт, регалии]

═══════════════════════════════

Напишите — обсудим ваш проект!
```

### Template C: Репетиторство / Индивидуальное обучение

```
[HOOK — предмет + формат + уровень]

═══════════════════════════════
ПРОГРАММА:
═══════════════════════════════

- [Тема 1]
- [Тема 2]

═══════════════════════════════
ФОРМАТ:
═══════════════════════════════

- Индивидуально / группа (до N чел.)
- Длительность занятия, кол-во в неделю
- Онлайн / у вас / у меня

═══════════════════════════════
ОБ УЧИТЕЛЕ:
═══════════════════════════════

[Опыт, образование, сертификаты]

═══════════════════════════════

Запишитесь на пробное занятие — звоните!
```

**Description rules:**
- First 2-3 lines = search preview, make them count
- ═══ separators for visual structure (OLX accepts them)
- Short paragraphs, plain text lists
- Price: "договорная" or real amount at the end
- CTA: "напишите/позвоните" (OLX shows phone automatically)
- **NO emojis anywhere** — OLX moderation rejects them (no 📍 💻 ⏱ 🎯 ✓ → • ★ 📞 etc.)
- **NO arrows** (→ ➜ ▶) — replace with plain dash or omit
- **NO bullet symbols** (• ▪ ●) — use plain dash (-) or numbered list (1. 2. 3.)
- Safe chars: letters, digits, dash (-), comma, colon, ═══ separator lines

## Phase 5: Image Prompts

Generate 8 prompts for design-social-post skill (Nano Banana 2). Use client brand colors from wiki.

**OLX carousel structure:**

| # | Slide | Content |
|---|-------|---------|
| 1 | Главный | Тема + фото преподавателя/автора + brand colors |
| 2 | Проблема | Боль ЦА (из client-profile) |
| 3 | Решение | Ключевой навык + инструмент |
| 4 | Программа | Модули/уроки курса |
| 5 | Для кого | Целевая аудитория (из funnel-strategy) |
| 6 | Результат | Deliverables: портфолио, навыки, сертификат |
| 7 | Преподаватель | Фото + регалии |
| 8 | CTA | "Напишите сейчас" + short pitch |

**Prompt format** (compatible with design-social-post):
```
"Social media post image, 2000x2000, square.
[Scene description].
Text on image (Russian, Cyrillic): '[ТЕКСТ]'
Background: [brand colors from wiki].
Style: modern, clean, professional. High quality."
```

**Requirements:** 2000x2000px (OLX optimal), max 5MB, no URLs/phones on images.

## Phase 6: Compliance Review

Run before delivering:

```
[ ] Title ≤ 70 characters
[ ] No income promises anywhere
[ ] No MLM/partner/recruitment language
[ ] No external links or URLs
[ ] Price is "договорная" or real amount
[ ] Category matches content
[ ] Description matches title
[ ] One service per ad
[ ] CTA = "напишите/позвоните" (not "перейдите по ссылке")
```

If ANY check fails → rewrite that section.

## Phase 7: Publish & Verify (optional)

If user says "опубликуй" — publish via agent-browser:

```bash
# Login (Google auth should be saved)
agent-browser open "https://www.olx.uz/post-new/"
agent-browser wait --timeout 5000
agent-browser snapshot -i

# Fill ad form
agent-browser fill @<title-input> "<TITLE>"
agent-browser fill @<description-textarea> "<DESCRIPTION>"
agent-browser fill @<price-input> "<PRICE>"
# Select category, upload images, submit

# Verify moderation (check after 15-30 min)
agent-browser open "https://www.olx.uz/myaccount/"
agent-browser wait --timeout 5000
agent-browser snapshot -i
# Check: "Активные" = passed, "На модерации" = pending, "Отклонённые" = failed
```

If rejected: read rejection reason, fix, resubmit.

## Phase 8: A/B Tracking

After 7-14 days, collect performance:

```bash
agent-browser open "https://www.olx.uz/myaccount/statistic/"
agent-browser snapshot -i
```

Extract per ad: views, unique views, phone reveals, messages.

Save to wiki:
```bash
cat >> /workspace/group/wiki/entities/<client>-olx-performance.md << EOF
## Ad #N: "<title>" (posted <date>)
Views: <N> | Unique: <N> | Phone: <N> | Messages: <N>
CTR estimate: <N>%
Notes: <observations>
EOF
```

Compare variants → use winning patterns for next ad cycle.

## Ad Lifecycle (30-day cycle)

| Day | Action |
|-----|--------|
| 1 | Publish ad |
| 3-5 | First metrics check — enough views? |
| 7 | A/B compare if multiple ads running |
| 14 | Mid-cycle: update description if low engagement |
| 25 | Prepare next ad (different angle, same service) |
| 28-30 | Old expires → new publishes (avoid gap) |

## Save & Deliver

Save to wiki: `wiki/entities/<client>-olx-ad-<N>.md` with title, description, prompts, compliance status.

Output:
```
📝 Объявление #N для OLX.uz
━━━━━━━━━━━━━━━━━━━━━━━━━
📌 Заголовок: <title> (<N> символов)
📂 Категория: <category>
💰 Цена: <price>
📝 Описание: <N> символов
📸 Баннеры: 8 промптов готовы

✅ Проверка модерации: пройдена
📊 Следующий чек метрик: через 7 дней
```
