---
name: design-avatar
description: Generate professional avatars for social media profiles and Telegram bots. Analyzes client profile, proposes styles, generates static + video avatars. Includes bot avatar for OctoFunnel. Use when asked to create avatars, profile pictures, or visual identity for a client.
---

# Avatar Designer

Generate avatar sets: client profile photo + Telegram bot avatar + optional video avatar. Uses client data from wiki and Nano Banana 2 for generation.

## Trigger

"сделай аватарку", "avatar", "аватарка для клиента", "аватарка бота", "profile picture", "фото профиля"

## Prerequisites

- `$OPENROUTER_API_KEY` for Nano Banana 2
- Client data in wiki (from instagram-analyzer, client-profile) — recommended
- If no client data: ask for photo + description

## Platform Specs

| Platform | Size | Format | Notes |
|----------|------|--------|-------|
| Telegram photo | 640x640 | JPEG/PNG | Circular crop |
| Telegram video | 640x640, max 10s | H.264 MP4, max 2MB | Loop, Premium feature |
| Instagram | 1080x1080 (upload) | JPEG | Displayed 320x320, circular |
| Bot avatar | 640x640 | JPEG/PNG | Set via MTProto, not Bot API |
| Universal | 1080x1080 | PNG | Works everywhere |

## Phase 1: Load Client Data

```
wiki/media/instagram/<client>/categories/author/  ← best author photos
instagram-analysis/<client>/face-reference.json   ← face description
client-profiles/<client>/profile.json             ← niche, style, brand
client-profiles/<client>/reference-photo.jpg      ← saved reference
wiki/entities/brand-<client>.md                   ← colors, tone
```

Extract: face description, brand colors, niche, style keywords, best author photo path.

If no data available — ask user for:
1. Photo of the person (or description)
2. Business niche
3. Preferred colors
4. Preferred style (or let AI decide)

## Phase 2: Propose Options

Present menu before generating:

```
АВАТАРКА ДЛЯ <имя>

Стиль:
1. Professional — чистый фон, деловой, минимализм
2. Creative — яркие цвета, абстрактный фон
3. Warm — мягкие тона, дружелюбно, природа
4. Tech — неон, геометрия, AI-визуал, тёмный фон
5. Luxury — золото, мрамор, элегантно
6. Minimalist — одноцветный фон, фокус на лице
7. Auto — подберу под нишу клиента

Фон:
A. Gradient (brand colors)
B. Solid color
C. Abstract/geometric
D. Nature blur
E. Studio bokeh
F. City/urban
G. Auto — подберу под стиль

Что генерируем:
- [x] Аватарка клиента (3 варианта)
- [x] Аватарка бота
- [ ] Видео-аватарка (нужен Kling/Runway API)
```

If user says "Auto" or doesn't choose — select based on client niche:
- IT/AI/Dev → Tech
- Coach/Psychologist/Yoga → Warm
- Business/Consulting → Professional
- Design/Marketing → Creative
- Premium services → Luxury

## Phase 3: Generate Client Avatars (3 variants)

```bash
export WD=/workspace/group/avatars/$(date +%Y%m%d-%H%M%S)
mkdir -p $WD
```

**With reference photo** (best quality — multimodal prompt):
```bash
PHOTO_B64=$(base64 -w0 "<path_to_reference_photo>")

curl -s -X POST "https://openrouter.ai/api/v1/chat/completions" \
  -H "Authorization: Bearer $OPENROUTER_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model":"google/gemini-3.1-flash-image-preview",
    "messages":[{"role":"user","content":[
      {"type":"image_url","image_url":{"url":"data:image/jpeg;base64,'"$PHOTO_B64"'"}},
      {"type":"text","text":"Create a professional profile avatar photo, 1080x1080 square, based on THIS person. EXTREME CLOSE-UP — face fills 80% of the frame. Head and upper shoulders only, NO torso. Style: <STYLE>. Background: <BACKGROUND with brand_colors>. Keep the person recognizable but enhance lighting. High quality, sharp focus on face. Designed for circular crop at small sizes."}
    ]}]
  }'
```

**Without reference photo** (from face description):
```
"Professional profile avatar, 1080x1080, square. EXTREME CLOSE-UP.
Person: <face_description from face-reference.json>. Face fills 80% of frame.
Head and upper shoulders only, no torso. Niche: <business_type>
Style: <selected_style>
Background: <selected_background>, colors: <brand_colors>
High quality, photorealistic, social media ready."
```

Generate 3 variants with different style/background combos. Save as:
- `$WD/avatar-1.png`
- `$WD/avatar-2.png`
- `$WD/avatar-3.png`

Send all 3 to user via send_file. Ask which they prefer.

## Phase 4: Generate Bot Avatar

**IMPORTANT: For personal brand bots (OctoFunnel workshops, courses) — bot avatar must use the SAME person's face as the client avatar, just in a different style. Users must associate the bot with the owner. Never use robot/mascot imagery for personal brand bots.**

Bot avatar = client's face + business/official style differentiation:

| Differentiator | How | Example |
|---------------|-----|---------|
| Background color | Different from personal avatar | Personal: dark → Bot: brand blue gradient |
| Subtle AI overlay | Thin neon frame, circuit lines around head | Glowing blue border around the face |
| Expression/mood | More serious/professional than personal | Confident business look vs friendly smile |
| Color temperature | Cooler/more digital tones | Personal: warm → Bot: cool blue tint |
| Geometric accent | Hexagons, data points in background | Subtle tech pattern behind head |

**With reference photo (best):**
```
"Professional business portrait avatar, 640x640, square, circular crop safe.
EXTREME CLOSE-UP of THIS person's face — face fills 80% of the frame.
Head and upper shoulders only, no torso.
Style: official, business, slightly digital/tech feel.
Background: <brand_color> gradient with subtle <geometric/circuit/neon> accents.
More serious expression than casual. Corporate confidence.
High quality, sharp focus on face. Clean composition."
```

**Without photo (from face description):**
```
"Business portrait avatar, 640x640, extreme close-up.
Person: <face_description>.
Face fills 80% of frame. Head and shoulders only.
Background: <brand_colors> with subtle tech overlay.
Official, corporate, digital feel. Professional confidence."
```

**Only use robot/mascot style for utility bots with no personal brand attached.**

Generate 2 variants. Save as `$WD/bot-avatar-1.png`, `$WD/bot-avatar-2.png`.

## Phase 5: Video Avatar

Uses OpenRouter Video API (`alibaba/wan-2.6`) — image-to-video from the static avatar.

### Video Presets

Present to user:
```
ВИДЕО-АВАТАРКА — выбери стиль:

1. Welcome — машет рукой, тёплая улыбка, светящиеся частицы
2. Tech CEO — zoom in, палец вверх, неоновый halo, цифровой код
3. Zen — мягкое дыхание, спокойная улыбка, природный боке
4. Energy — поворот к камере, thumbs up, пульсирующий градиент
5. Luxury — поправляет пиджак, золотые частицы, мрамор
```

### Preset Prompts

| Preset | Prompt |
|--------|--------|
| Welcome | "The person smiles warmly and waves hello to the camera with their right hand. Glowing particles and light sparkles float around them. Animated gradient background. Energetic and welcoming." |
| Tech CEO | "Cinematic slow zoom into the person's face. A bright neon blue and purple halo glows behind their head, pulsating gently. Digital code and data streams flow in the background. The person gives a thumbs up with a confident smile. Futuristic tech vibe. Epic lighting." |
| Zen | "The person breathes slowly and peacefully, serene gentle smile. Soft nature bokeh background with warm golden light filtering through. Floating soft light orbs. Calm and meditative atmosphere." |
| Energy | "The person turns toward the camera with an energetic smile and gives a thumbs up. Background gradient pulses with colorful light waves. Dynamic and motivational. High energy." |
| Luxury | "The person makes a subtle confident movement, adjusts their collar or blazer. Gold particles drift slowly in the air. Background has marble texture with soft lighting. Elegant and premium." |

### Generate Video

```bash
AVATAR_B64=$(base64 -w0 "$WD/<chosen-avatar>.png")

RESPONSE=$(curl -s -X POST "https://openrouter.ai/api/v1/videos" \
  -H "Authorization: Bearer $OPENROUTER_API_KEY" \
  -H "Content-Type: application/json" \
  -d "{
    \"model\": \"alibaba/wan-2.6\",
    \"prompt\": \"<PRESET_PROMPT>\",
    \"frame_images\": [{\"type\": \"image_url\", \"image_url\": {\"url\": \"data:image/png;base64,${AVATAR_B64}\"}, \"frame_type\": \"first_frame\"}],
    \"duration\": 5
  }")

VIDEO_ID=$(echo "$RESPONSE" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.parse(d).id))")
echo "Video ID: $VIDEO_ID — polling..."
```

### Poll Until Complete (every 15 seconds)

```bash
while true; do
  STATUS=$(curl -s "https://openrouter.ai/api/v1/videos/$VIDEO_ID" \
    -H "Authorization: Bearer $OPENROUTER_API_KEY" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{const j=JSON.parse(d);console.log(j.status);if(j.status==='completed')console.log(j.unsigned_urls?.[0]||'')})")
  echo "Status: $STATUS"
  [ "$STATUS" = "completed" ] || [ "$STATUS" = "failed" ] && break
  sleep 15
done
```

### Download & Post-process

```bash
curl -sL "<DOWNLOAD_URL>" \
  -H "Authorization: Bearer $OPENROUTER_API_KEY" \
  -o $WD/video-raw.mp4

ffmpeg -y -i $WD/video-raw.mp4 \
  -vf "scale=640:640" \
  -c:v libx264 -b:v 2500k -maxrate 2800k -bufsize 5000k \
  -an -movflags +faststart \
  $WD/video-avatar.mp4

# Verify: must be ≤ 2MB for Telegram
SIZE=$(stat -f%z $WD/video-avatar.mp4 2>/dev/null || stat -c%s $WD/video-avatar.mp4)
[ "$SIZE" -gt 2097152 ] && echo "WARNING: file > 2MB, re-encode with lower bitrate"
```

Cost: ~$0.50 per 5-second video. Generation time: ~1-2 minutes.

## Phase 6: Set Bot Avatar (optional)

If user says "установи аватарку бота":

Use telegram-scanner MCP tool `set_bot_avatar`:
```
set_bot_avatar(bot_username="<bot>", image_path="<path_to_bot_avatar>")
```

This uses MTProto (Telethon) through the owner's account — Bot API doesn't support this.

If tool not available — instruct: "Отправь фото @BotFather с командой /setuserpic"

## Phase 7: Save & Deliver

Save to wiki:
```bash
mkdir -p /workspace/group/wiki/media/avatars/<client>/
cp $WD/avatar-*.png /workspace/group/wiki/media/avatars/<client>/
cp $WD/bot-avatar-*.png /workspace/group/wiki/media/avatars/<client>/
[ -f $WD/video-avatar.mp4 ] && cp $WD/video-avatar.mp4 /workspace/group/wiki/media/avatars/<client>/
```

Deliver to user:
```
Визуальный комплект для <имя>:

1. Аватарка для соцсетей — 3 варианта (1080x1080)
   Подходит: Telegram, Instagram, LinkedIn, Facebook

2. Аватарка бота — 2 варианта (640x640)
   Для OctoFunnel Telegram бота

3. Видео-аватарка — 10сек loop (640x640)
   Для Telegram Premium профиля

Все файлы сохранены в wiki/media/avatars/<client>/
```

## Cost

- Static avatars: 5 images x $0.003 = ~$0.015
- Video avatar: depends on API ($0.05-0.50 per generation)
- Total static set: under $0.02
