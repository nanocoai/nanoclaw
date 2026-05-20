---
name: client-profile
description: Create a unified client profile by merging data from Instagram, Website, and YouTube analyses. Produces a single comprehensive document with all business intelligence for Okto funnel creation. Use when asked to create/build a client profile, or after completing analyses across multiple platforms.
---

# Unified Client Profile Builder

Merge all collected intelligence about a client (Instagram, Website, YouTube) into a single comprehensive profile. This profile becomes the foundation for funnel strategy and the main reference document when working with this client.

## Trigger

When user asks to:
- "создай профиль клиента", "build client profile"
- "объедини данные по клиенту"
- "client profile @username"
- After completing analyses on multiple platforms

## Data Sources

Scan for all available data about the client:

```bash
USERNAME="<username>"
echo "=== Instagram ===" && ls /workspace/group/wiki/entities/$USERNAME.md 2>/dev/null && echo "OK" || echo "MISSING"
echo "=== Instagram Audit ===" && ls /workspace/group/wiki/entities/$USERNAME-audit.md 2>/dev/null && echo "OK" || echo "MISSING"
echo "=== Website ===" && ls /workspace/group/wiki/entities/*domain*.md 2>/dev/null && echo "OK" || echo "MISSING"
echo "=== YouTube ===" && ls /workspace/group/youtube-analysis/*/channel-summary.json 2>/dev/null && echo "OK" || echo "MISSING"
echo "=== Okto Summary ===" && ls /workspace/group/instagram-analysis/$USERNAME/okto-summary.json 2>/dev/null && echo "OK" || echo "MISSING"
echo "=== Media Catalog ===" && ls /workspace/group/wiki/media/instagram/$USERNAME/catalog.md 2>/dev/null && echo "OK" || echo "MISSING"
```

If key data is missing → suggest: "Нет данных по YouTube. Запустить анализ канала?"

Read ALL available sources before synthesizing.

## Workflow

### Phase 1: Collect & Read All Sources

Read every available file:
- `wiki/entities/<username>.md` — Instagram profile analysis
- `wiki/entities/<username>-audit.md` — marketing audit
- `wiki/entities/<domain>.md` — website analysis
- `wiki/entities/<youtube-channel>.md` — YouTube analysis
- `instagram-analysis/<username>/okto-summary.json` — structured IG data
- `website-analysis/<domain>/site-analysis.json` — structured website data
- `youtube-analysis/<channel>/channel-summary.json` — structured YT data
- `wiki/media/instagram/<username>/catalog.md` — photo catalog
- `wiki/media/youtube/<channel>/catalog.md` — video thumbnails
- `wiki/media/website/<domain>/catalog.md` — website screenshots

### Phase 2: Cross-Reference & Deduplicate

Merge data intelligently:
- **Services:** combine from IG bio + website services page + YT video topics. Deduplicate.
- **Pricing:** website prices are most reliable, IG posts second, YT mentions third.
- **Audience:** IG comments + YT comments + website testimonials → unified audience portrait.
- **Visual brand:** IG palette + website palette → find common colors = true brand colors.
- **Tone/language:** compare IG captions vs YT speech vs website copy → identify consistent voice.
- **Content assets:** merge photo catalog + video catalog + website screenshots.

### Phase 3: Generate Unified Profile

**File:** `wiki/entities/client-<name>.md`

```yaml
---
title: "Client Profile — <Name>"
type: entity
subtype: client-profile
created: YYYY-MM-DD
updated: YYYY-MM-DD
sources_analyzed:
  instagram: "@<username>"
  website: "<domain>"
  youtube: "@<channel>"
related: ["[[entities/<username>]]", "[[entities/<domain>]]", "[[entities/<channel>]]"]
tags: [client-profile, okto, sales-funnel]
confidence: high
---
```

**Sections:**

**1. Identity**
- Name, title/role, niche
- Geography, languages
- All platform links (IG, YT, website, Telegram, etc.)
- Avatar/face description (from face-reference.json)

**2. Business Model**
- What they sell (services vs products vs both)
- How they deliver (online/offline/hybrid)
- Revenue model (per-session, subscription, course, partnership)
- Price range (with specific prices where known)
- Booking/purchase method (DM, website, phone, booking form)

**3. Services & Products (unified)**
| Service/Product | Source | Price | Description |
|----------------|--------|-------|-------------|
| ... | IG + Website | $X | ... |

**4. Audience Profile**
- Demographics: age, gender, geography, language
- Interests and pain points (from comments IG + YT)
- FAQ (most common questions from comments)
- Buying behavior: how they typically find and purchase

**5. Visual Brand**
- Primary colors: [hex codes] — from IG + Website analysis
- Typography: serif/sans-serif (from website)
- Photography style: professional/casual/studio
- Video production: quality level, format preferences
- Brand consistency score: high/medium/low across platforms

**6. Communication Style**
- Tone: formal/casual/expert/friendly (consistent across platforms?)
- Language: primary + secondary
- Emoji usage: heavy/moderate/minimal
- Storytelling: narrative style in captions vs videos vs website

**7. Content Strategy**
| Platform | Frequency | Best Format | Top Topics | Engagement |
|----------|-----------|-------------|------------|------------|
| Instagram | X/week | Reels/Posts | ... | ER% |
| YouTube | X/month | Tutorials/Vlogs | ... | Avg views |
| Website | - | Pages | ... | - |

**8. Social Proof & Trust**
- Testimonials count and quality
- Before/after cases
- Certifications, awards
- Media mentions
- Client count (if known)

**9. Available Assets for Funnels**
| Type | Count | Best Examples | Source |
|------|-------|---------------|--------|
| Author photos (banner-worthy) | N | portrait-3, portrait-9 | IG catalog |
| Product/service photos | N | ... | IG catalog |
| Video lessons | N | "Yoga basics", "..." | YouTube |
| Testimonial videos | N | ... | YouTube |
| Website screenshots | N | homepage, pricing | Website |
| Transcripts | N | ... | YT + IG reels |

**10. Funnel Readiness Assessment**
- Ready assets: what already exists for funnels
- Missing pieces: what needs to be created
- Quick win: easiest funnel to launch first
- Readiness score: high/medium/low
- Estimated time to first funnel: X days

### Phase 4: Save Reference Photo

Find the best author photo and save as reference for avatars and funnels:

```bash
CLIENT="<name>"
mkdir -p /workspace/group/client-profiles/$CLIENT

# Priority: categories/author → scored posts with hasOwnerFace → profile avatar
AUTHOR_DIR="/workspace/group/wiki/media/instagram/<username>/categories/author"
if [ -d "$AUTHOR_DIR" ] && ls "$AUTHOR_DIR"/*.jpg 2>/dev/null | head -1; then
  cp "$(ls -t $AUTHOR_DIR/*.jpg | head -1)" /workspace/group/client-profiles/$CLIENT/reference-photo.jpg
elif [ -f "/workspace/group/instagram-analysis/<username>/images/post-1.jpg" ]; then
  # Fallback: use first scored post with owner face
  cp /workspace/group/instagram-analysis/<username>/images/post-1.jpg /workspace/group/client-profiles/$CLIENT/reference-photo.jpg
fi
```

Add to profile.json: `"referencePhoto": "client-profiles/<name>/reference-photo.jpg"`

This photo is used by:
- `design-avatar` — for generating profile pictures
- `octofunnel-creator` — for OKTO reference photos
- `design-youtube-thumbnail` — for thumbnails with author face

### Phase 5: Generate client-profile.json

Save machine-readable version:

```bash
cat > /workspace/group/client-profiles/<name>/profile.json << 'EOF'
{
  "clientName": "", "niche": "", "geography": "", "languages": [],
  "platforms": {"instagram":"","website":"","youtube":""},
  "services": [{"name":"","price":"","source":"","description":""}],
  "products": [],
  "pricing": {"currency":"","range":{"min":0,"max":0},"items":[]},
  "audience": {"demographics":"","painPoints":[],"faq":[],"buyingBehavior":""},
  "brand": {"primaryColors":[],"typography":"","photoStyle":"","videoQuality":"","consistency":""},
  "tone": "", "language": "", "emojiStyle": "",
  "engagement": {"instagram":{"er":0,"followers":0},"youtube":{"subscribers":0,"avgViews":0}},
  "availableAssets": {
    "authorPhotos":[], "productPhotos":[], "videoLessons":[],
    "testimonials":[], "screenshots":[], "transcripts":[]
  },
  "funnelReadiness": "high|medium|low",
  "quickWinFunnel": "",
  "createdAt": ""
}
EOF
```

### Phase 6: Generate Client Report (shareable gift)

Create a polished report that can be shared with the client:

```bash
CLIENT="<name>"
cat > /workspace/group/client-profiles/$CLIENT/report.md << 'REPORT'
# Анализ онлайн-присутствия: <Client Name>

Подготовлено: AshotAI | <date>

---

## Ваши сильные стороны
- <top 3-5 strengths from audit>

## Что можно улучшить
- <top 3-5 actionable improvements>

## Ваша аудитория
- <demographics, interests, pain points>

## Рекомендуемая стратегия

Быстрый старт (первая неделя):
- <quick win funnel recommendation>

Среднесрочный план (1-3 месяца):
- <growth strategy>

## Визуальный бренд
- Основные цвета: <hex codes>
- Стиль: <description>
- Рекомендации: <suggestions>

## Рекомендуемые воронки продаж

| Воронка | Тип | Ожидаемый результат |
|---------|-----|---------------------|
| <funnel 1> | <type> | <outcome> |

---
Анализ подготовлен с помощью AI-платформы AshotAI
REPORT
```

Send report via send_file: "Отчёт для клиента <name> — можно отправить как подарок"

### Phase 7: Save & Finalize

- Update wiki index + log: `## [YYYY-MM-DD] ingest | Client profile: <Name>`
- Cross-link all related entity pages
- Git commit
- Send summary to user with key highlights and readiness assessment

## Re-profiling

If profile already exists → READ existing, MERGE new data, note changes:
"Обновление профиля: добавлены данные YouTube, обнаружена новая услуга..."

## Cost

Zero API cost — reads existing data only.
