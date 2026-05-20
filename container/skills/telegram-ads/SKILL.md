---
name: telegram-ads
description: Generate Telegram Ads creatives — ad copy, banner images, and video ads. Analyzes client profile and funnel to craft compliant ads that convert. Supports sponsored messages (text), media-enhanced ads (image/video), and story ads. Use when asked to create Telegram ad campaigns or creatives.
---

# Telegram Ads Creative Generator

Generate complete ad packages: copy + image + video for Telegram Ads platform (ads.telegram.org).

## Trigger

"реклама в телеграм", "telegram ad", "telegram ads", "рекламный баннер", "креатив для телеграм"

## Prerequisites

- `$OPENROUTER_API_KEY` for image + video generation
- Client data from wiki (recommended) or ad text from user
- Funnel URL or bot username (what we're advertising)

## Telegram Ads Specs

### Ad Placements

| Placement | Text | Image | Video | CTA |
|-----------|------|-------|-------|-----|
| Sponsored message (classic) | 160 chars | No | No | 30 chars button |
| Sponsored message (media) | 160 chars | Yes | Yes | 30 chars button |
| Story ad (full-screen) | Overlay | 1080x1920 | 1080x1920, 15s | Swipe-up |

### Image Specs
- **Sponsored media:** 1280x720 (16:9 landscape) or 1080x1080 (1:1 square)
- **Story ad:** 1080x1920 (9:16 portrait, full-screen)
- **Format:** JPG/PNG, max 5MB
- **Text on image:** max 20% area
- Design for BOTH dark and light Telegram themes

### Video Specs
- **Sponsored media:** 1280x720 (16:9), up to 15 seconds
- **Story ad:** 1080x1920 (9:16), up to 15 seconds
- **Format:** H.264 MP4, max 10MB (sponsored) / 30MB (stories)
- **Audio:** Optional, muted by default — design for sound-off
- **Hook:** First 2 seconds must grab attention

### Text Rules
- Max 160 characters ad text (80-120 optimal)
- Max 30 characters CTA button
- No ALL CAPS entire text
- No excessive punctuation (!!!, ???)
- Emojis allowed (limited, 1-2 max)
- Language must match target audience
- No phone numbers in text
- No misleading or clickbait claims
- Review time: 24-48 hours

## Phase 1: Load Context

```
wiki/entities/olx-uz-platform.md              ← reference for compliance mindset
wiki/entities/<client>.md                      ← client profile
wiki/entities/<client>-funnel-strategy.md      ← which funnel to advertise
wiki/entities/brand-<client>.md                ← colors, tone
client-profiles/<client>/profile.json          ← structured data
client-profiles/<client>/reference-photo.jpg   ← for image generation
```

Extract: niche, USP, target audience pain points, brand colors, funnel URL/bot, credentials.

If user provides ad text — skip to Phase 3.
If no data — ask: "Что рекламируем? (бот/канал/воронка) + для кого?"

## Phase 2: Generate Ad Copy

### Step 1: Choose ad goal

```
Цель рекламы:
1. Подписка на канал — "Подписывайся на @channel"
2. Запуск бота — "Запусти @bot и получи..."
3. Переход на воронку — "Регистрируйся на вебинар/курс"
4. Mini App — "Открой приложение"
```

### Step 2: Write 3 variants (A/B/C)

Use AIDA framework adapted for 160 chars:

**Template: Attention + Interest + CTA**
```
[Attention hook — боль или вопрос] + [Benefit — что получит] + [CTA button — действие]
```

**Examples by niche:**

IT/AI обучение:
```
A: "Нейросети создают сайты за 30 минут. Научись этому бесплатно — 3 урока с практикой"
   CTA: "Начать обучение"

B: "ИИ заменит маркетологов? Нет — но маркетолог с ИИ заменит без. Освой за неделю"
   CTA: "Узнать как"

C: "Создавай лендинги, боты и воронки с помощью ИИ. Без кода, без дизайнера"
   CTA: "Попробовать бесплатно"
```

Услуги:
```
A: "Упаковка бизнеса онлайн за 30 минут. ИИ делает сайт, бота и воронку за вас"
   CTA: "Получить демо"

B: "<Name> помог 50+ клиентам запустить онлайн-продажи. Бесплатная консультация"
   CTA: "Записаться"
```

**Rules for each variant:**
- Count characters: body ≤ 160, CTA ≤ 30
- No ALL CAPS
- Max 1-2 emoji
- First 50 chars = hook (visible in preview)
- Specific > generic ("30 минут" > "быстро")
- Question hooks have highest CTR

Show all 3 to user, ask which to develop visuals for.

## Phase 3: Generate Ad Image

### Step 1: Choose format

```
Формат баннера:
1. Landscape 16:9 (1280x720) — для sponsored message
2. Square 1:1 (1080x1080) — для sponsored message
3. Story 9:16 (1080x1920) — для story ads
4. Все три — полный комплект
```

### Step 2: Design concept from ad copy

Analyze the chosen ad text and extract:
- **Key visual idea** — what image communicates the message
- **Emotional tone** — urgency, curiosity, trust, excitement
- **Color scheme** — from brand guide or auto-select

### Image Presets

| Preset | Visual | Best for |
|--------|--------|----------|
| Problem-Solution | Split: grey/dull left (problem) → bright/colorful right (solution) | Course/education |
| Social Proof | Person + numbers/metrics overlay | Consulting/services |
| Tool Demo | Screenshot/mockup of the product in action | SaaS/bot/app |
| Face + Hook | Person's face + large text hook on branded bg | Personal brand |
| Minimalist | Bold text on gradient, no photo | Universal |
| Before-After | Two states side by side | Transformation |

### Step 3: Generate

```bash
export WD=/workspace/group/telegram-ads/$(date +%Y%m%d-%H%M%S)
mkdir -p $WD
```

**With client reference photo:**
```bash
PHOTO_B64=$(base64 -w0 "<reference_photo_path>")

curl -s -X POST "https://openrouter.ai/api/v1/chat/completions" \
  -H "Authorization: Bearer $OPENROUTER_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model":"google/gemini-3.1-flash-image-preview",
    "messages":[{"role":"user","content":[
      {"type":"image_url","image_url":{"url":"data:image/jpeg;base64,'"$PHOTO_B64"'"}},
      {"type":"text","text":"Telegram ad banner, <WIDTH>x<HEIGHT>.
Ad concept: <VISUAL_CONCEPT>.
Use THIS person in the image.
Text overlay (Russian, Cyrillic, large and readable): '"'"'<SHORT_HOOK_TEXT>'"'"'
Background: <brand_colors gradient/solid>.
Style: modern, clean, high contrast, works on both dark and light backgrounds.
Minimal text — max 20% of image area. No small text. Bold and readable.
Professional advertising quality."}
    ]}]
  }'
```

**Without photo (text-focused):**
```
"Telegram ad banner, <WIDTH>x<HEIGHT>.
<VISUAL_CONCEPT>.
Large bold text (Russian, Cyrillic): '<HOOK_TEXT>'
Smaller subtitle: '<BENEFIT_TEXT>'
Background: <brand_colors>.
Style: advertising, high contrast, attention-grabbing.
Works on both dark and light Telegram themes.
Max 20% text coverage. Clean, no clutter."
```

Generate 2-3 variants per format. Save to `$WD/`.

## Phase 4: Generate Ad Video

### Step 1: Choose video preset

```
Видео-реклама:
1. Kinetic Text — анимированный текст на градиенте (5-10 сек)
2. Person + Effects — человек + VFX на фоне (5 сек)
3. Product Demo — показ продукта/бота в действии (10-15 сек)
4. Story Hook — интригующее начало + CTA (5-10 сек)
```

### Video Preset Prompts

| Preset | Prompt |
|--------|--------|
| Kinetic Text | "Animated text appearing word by word on a vibrant gradient background. Bold Russian text: '<AD_TEXT>'. Colors shift smoothly. Modern motion graphics style. Professional ad quality." |
| Person + Effects | "The person looks at camera, smiles confidently, <action>. Glowing particles and light effects around them. Text overlay appears: '<HOOK>'. Background: <brand_colors>. Cinematic, professional ad." |
| Product Demo | "Screen recording style: a phone/laptop showing a chat bot interface. Messages appear one by one. Clean UI. Text overlay: '<BENEFIT>'. Professional product demo aesthetic." |
| Story Hook | "Fast-paced montage: <problem_scene> cuts to <solution_scene>. Text flashes: '<HOOK>'. Ends with CTA: '<CTA_TEXT>'. Energetic, attention-grabbing. 9:16 vertical." |

### Step 2: Generate via OpenRouter Video API

```bash
# For sponsored message video (16:9):
IMAGE_B64=$(base64 -w0 "$WD/<best-banner>.png")

RESPONSE=$(curl -s -X POST "https://openrouter.ai/api/v1/videos" \
  -H "Authorization: Bearer $OPENROUTER_API_KEY" \
  -H "Content-Type: application/json" \
  -d "{
    \"model\": \"alibaba/wan-2.6\",
    \"prompt\": \"<PRESET_PROMPT>\",
    \"frame_images\": [{\"type\": \"image_url\", \"image_url\": {\"url\": \"data:image/png;base64,${IMAGE_B64}\"}, \"frame_type\": \"first_frame\"}],
    \"duration\": 5
  }")

VIDEO_ID=$(echo "$RESPONSE" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.parse(d).id))")
```

Poll + download + post-process (same as design-avatar):
```bash
# Wait for completion
# Download from unsigned_urls[0]
# Post-process:
ffmpeg -y -i $WD/video-raw.mp4 \
  -vf "scale=1280:720" \
  -c:v libx264 -b:v 3000k -maxrate 4000k \
  -an -movflags +faststart \
  -t 15 \
  $WD/video-ad-16x9.mp4

# Verify ≤ 10MB
```

For story format (9:16), adjust scale to 1080:1920.

## Phase 5: Compliance Review

```
TELEGRAM ADS CHECKLIST:
[ ] Ad text ≤ 160 characters
[ ] CTA button text ≤ 30 characters
[ ] No ALL CAPS entire text
[ ] No excessive punctuation
[ ] Max 1-2 emoji
[ ] No phone numbers in text
[ ] No misleading claims
[ ] No prohibited content (drugs, weapons, adult, gambling)
[ ] Image text ≤ 20% area
[ ] Image works on dark + light theme
[ ] Video ≤ 15 seconds
[ ] Video file ≤ 10MB (sponsored) / 30MB (story)
[ ] Hook in first 2 seconds of video
[ ] Language matches target audience
[ ] Destination URL/bot/channel is valid
```

## Phase 6: Save & Deliver

Save to wiki:
```bash
cat > /workspace/group/wiki/entities/<client>-telegram-ad-<N>.md << 'EOF'
# Telegram Ad #N: <client>
Date: <date>
Goal: <subscription/bot/funnel>
Destination: <@bot or URL>

## Ad Variants
A: "<text>" | CTA: "<cta>"
B: "<text>" | CTA: "<cta>"
C: "<text>" | CTA: "<cta>"

## Creatives
- Banner 16:9: <path>
- Banner 1:1: <path>
- Story 9:16: <path>
- Video 16:9: <path>

## Compliance: PASSED
EOF
```

Deliver full package:
```
Рекламный пакет для Telegram Ads
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Цель: <goal>
Аудитория: <target>

Тексты (3 варианта A/B/C):
A: "<text>" [<chars> символов]
B: "<text>" [<chars> символов]
C: "<text>" [<chars> символов]

Баннеры: 16:9 + 1:1 + 9:16 (story)
Видео: 5-15 сек, H.264

Рекомендация: запустить A и B на тест, бюджет 50/50.
Проверка через 48ч после модерации.

Стоимость генерации: ~$0.02 (images) + ~$0.50 (video)
```

## A/B Testing Strategy

After launch:
- Run 2-3 text variants on same audience
- Run image vs video on same text
- Check after 48-72 hours: CTR, CPC, conversions
- Kill underperformers, scale winners
- Iterate: new variants based on winning patterns

## Cost

- Ad copy: $0 (generated by agent)
- Images (3 formats x 2 variants): ~$0.02
- Video (1 variant): ~$0.50
- Total creative package: ~$0.55
