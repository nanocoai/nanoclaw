---
name: mer-audio-digest
description: Check ranto28 (메르) Naver blog for new posts, generate English NotebookLM audio overviews, and announce URLs in the podcast Discord channel. Triggers on "/mer-audio-digest", "메르 오디오 업데이트", or scheduled cron. Supports `--test` for a one-post dry run without state updates.
allowed-tools: Bash(curl:*), Bash(python3:*), Bash(notebooklm:*), Bash(mkdir:*), Bash(cat:*), Bash(ln:*), Bash(printf:*)
---

# 메르 Audio Digest

**Must run in the `podcast` channel** (JID `dc:1495455110007099612`). Output goes to the current channel via `send_message`; scheduled retries must carry `target_group_jid=dc:1495455110007099612`.

## Invocation modes

| Mode | How detected | Behavior |
|---|---|---|
| **Script-backed cron** | Prompt begins with `[SCHEDULED TASK]` and the script output JSON contains `new_posts` | Skip steps 1–2 (the script already did the fetch+diff). Use `data.new_posts` as the target list. Commit state after each post. |
| **Manual / fresh** | No `[SCHEDULED TASK]` wrapper | Run steps 1–2 to fetch + diff inline. Commit state (bootstrap rule: if state is empty, process only latest 1 and seed all 30 seen). |
| **Test** | `--test` flag | Run steps 1–2, process latest 1 only, do **not** write state. |

## Config

```
BLOG_ID    = ranto28
STATE      = /workspace/extra/webdav-data/.mer_seen.json
CONTENT    = /workspace/extra/webdav-data/public/mer/
PUBLIC_URL = https://macmini.ewe-hadar.ts.net/mer/    # served via Tailscale Funnel, no auth
AUDIO_OPTS = --language en --length default --format deep-dive
PODCAST_JID = dc:1495455110007099612
```

State file stays private (under `webdav-data/`, not `webdav-data/public/`). Only `.md` and `.mp3` artifacts are public.

## Filename convention

```
BASE = "{DATE}_{HHMM}_{SAFE_TITLE}"
MD   = "{CONTENT}{BASE}.md"
MP3  = "{CONTENT}{BASE}_en.mp3"
```

Where:
- `DATE` and `HHMM` come from the post's actual publish timestamp in **KST** (e.g. `2026-05-05` + `0010`). The list API only returns relative dates ("2시간 전") or YYYY.M.D — fetch the mobile blog page to get the exact ms epoch.
- `SAFE_TITLE` = title with these chars stripped: `\ / ? # & % < > : " | *` and any control chars. Trim to 80 chars. Keep spaces and Korean as-is.

Build helper (use in step 3a and the retry-resume prompt):

```bash
# Fetch publish timestamp (KST) from mobile blog page
TS_MS=$(curl -s -A "Mozilla/5.0 (iPhone)" "https://m.blog.naver.com/ranto28/${LOG_NO}" \
  | python3 -c "import sys,re; m=re.search(r'addDate[\"\']?\s*[:=]\s*[\"\']?(\d{13})', sys.stdin.read()); print(m.group(1) if m else '')")
read DATE HHMM <<<"$(python3 -c "
from datetime import datetime, timezone, timedelta
ts_ms = '${TS_MS}'
KST = timezone(timedelta(hours=9))
if ts_ms:
    dt = datetime.fromtimestamp(int(ts_ms)/1000, tz=KST)
    print(dt.strftime('%Y-%m-%d'), dt.strftime('%H%M'))
")"
# Fallback if mobile fetch failed: use list-API DATE and HHMM=0000
if [ -z "$DATE" ]; then DATE="$LIST_DATE"; HHMM="0000"; fi

SAFE_TITLE=$(printf '%s' "$TITLE" | python3 -c "
import sys, re
t = sys.stdin.read().strip()
t = t.replace('&quot;','').replace('&amp;','&').replace('​','')
t = re.sub(r'[\\\\/?#&%<>:\"|*\x00-\x1f]', '', t)
print(t[:80].rstrip())
")
BASE="${DATE}_${HHMM}_${SAFE_TITLE}"
```

When announcing, **URL-encode** the basename so spaces/Korean become `%20`/`%xx`:

```bash
URL=$(printf '%s' "${BASE}_en.mp3" | python3 -c "import sys,urllib.parse;print('${PUBLIC_URL}'+urllib.parse.quote(sys.stdin.read()))")
```

> Two posts with the same KST minute would collide (extremely rare for a single blog). If you see one, report and we'll add seconds.

## Preamble (once per invocation)

```bash
mkdir -p /workspace/extra/webdav-data/public/mer
# NotebookLM auth: the allowlist automounts /Users/whahn/.notebooklm at
# /workspace/extra/.notebooklm (dot-prefixed basename). Link to CLI default.
ln -sfn /workspace/extra/.notebooklm /home/node/.notebooklm
```

## Workflow

### 0. Script-backed shortcut

If the prompt starts with `[SCHEDULED TASK]` and the embedded JSON contains `new_posts`, parse that list and jump straight to step 3. Set `commit_state = true` (not `--test`). Skip steps 1 and 2 — the script already fetched and diffed.

### 1. Fetch blog post list

```bash
python3 << 'EOF'
import urllib.request, re, json
from urllib.parse import unquote_plus
url = "https://blog.naver.com/PostTitleListAsync.naver?blogId=ranto28&currentPage=1&countPerPage=30"
req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0", "Referer": "https://blog.naver.com/ranto28"})
raw = urllib.request.urlopen(req).read().decode()
posts = []
for m in re.finditer(r'\{"sellerServiceStatus[^}]+\}', raw):
    o = m.group(0)
    logno = re.search(r'"logNo":"(\d+)"', o)
    title = re.search(r'"title":"([^"]+)"', o)
    date  = re.search(r'"addDate":"([^"]+)"', o)
    if logno and title:
        posts.append({
            "logno": logno.group(1),
            "date": (date.group(1).replace(".", "-") if date else ""),
            "title": unquote_plus(title.group(1)),
        })
print(json.dumps(posts, ensure_ascii=False))
EOF
```

Normalize `date` to `YYYY-MM-DD`. On fetch failure or empty list: reply with the error and stop (no state change).

### 2. Select targets

```
state = read STATE or {"seen_log_nos": [], "last_check": null}

if --test:
    target = [latest_posts[0]]
    commit_state = false
    bootstrap_all_seen = false
elif not state.seen_log_nos:               # bootstrap
    target = [latest_posts[0]]
    commit_state = true
    bootstrap_all_seen = true              # after success, mark all 30 seen
else:
    target = [p for p in latest_posts if p.logno not in state.seen_log_nos]
    commit_state = true
    bootstrap_all_seen = false

if target is empty: **exit silently — do NOT call `send_message`**. Wrap your reasoning in `<internal>No new 메르 posts since {last_check}.</internal>` so it's logged without being delivered to the channel.
```

### 3. Per-post pipeline

For each `post` in `target`:

**3a. Crawl + save markdown**

```bash
LOG_NO=<post.logno>; LIST_DATE=<post.date>; TITLE=<post.title>

# Build BASE per "Filename convention" section (DATE+HHMM from mobile page, fallback to LIST_DATE)
TS_MS=$(curl -s -A "Mozilla/5.0 (iPhone)" "https://m.blog.naver.com/ranto28/${LOG_NO}" \
  | python3 -c "import sys,re; m=re.search(r'addDate[\"\']?\s*[:=]\s*[\"\']?(\d{13})', sys.stdin.read()); print(m.group(1) if m else '')")
read DATE HHMM <<<"$(python3 -c "
from datetime import datetime, timezone, timedelta
ts_ms = '${TS_MS}'
KST = timezone(timedelta(hours=9))
if ts_ms:
    dt = datetime.fromtimestamp(int(ts_ms)/1000, tz=KST)
    print(dt.strftime('%Y-%m-%d'), dt.strftime('%H%M'))
")"
if [ -z "$DATE" ]; then DATE="$LIST_DATE"; HHMM="0000"; fi
SAFE_TITLE=$(printf '%s' "$TITLE" | python3 -c "
import sys, re
t = sys.stdin.read().strip()
t = t.replace('&quot;','').replace('&amp;','&').replace('\u200b','')
t = re.sub(r'[\\\\/?#&%<>:\"|*\x00-\x1f]', '', t)
print(t[:80].rstrip())
")
BASE="${DATE}_${HHMM}_${SAFE_TITLE}"
MD="/workspace/extra/webdav-data/public/mer/${BASE}.md"
MP3="/workspace/extra/webdav-data/public/mer/${BASE}_en.mp3"

BODY=$(curl -s -A "Mozilla/5.0" \
  "https://blog.naver.com/PostView.naver?blogId=ranto28&logNo=${LOG_NO}&redirect=Dlog&widgetTypeCall=true&noTrackingCode=true&directAccess=false" \
| python3 -c "
import sys, re
html = sys.stdin.read()
out = []
for s in re.findall(r'<span[^>]*se-fs-fs16[^>]*>(.*?)</span>', html, re.DOTALL):
    t = re.sub(r'<[^>]+>', '', s).replace('&quot;','\"').replace('&amp;','&').replace('\u200b','').strip()
    if t: out.append(t)
print('\n'.join(out))
")

printf '# %s\n\n- **Source:** https://blog.naver.com/ranto28/%s\n- **Date:** %s\n\n---\n\n%s\n' \
  "$TITLE" "$LOG_NO" "$DATE" "$BODY" > "$MD"
```

If `$BODY` is empty, use the `id="postViewArea"` fallback (see `naver-reader` skill). Still empty → skip this post; do NOT mark seen.

**3b. NotebookLM**

```bash
NB_ID=$(notebooklm create "mer_${DATE}_${LOG_NO}" --json | python3 -c "import sys,json;print(json.load(sys.stdin)['id'])")
notebooklm source add "$MD" --notebook "$NB_ID" --wait
notebooklm generate audio --notebook "$NB_ID" --language en --length default --format deep-dive \
  "Faithful English overview: key arguments, evidence, author's stance." --wait
notebooklm download audio --notebook "$NB_ID" "$MP3"
```

Rate-limit on any step → **Retry Protocol** below. Never `sleep`.

**3c. Announce in the channel**

Build the URL with proper percent-encoding of the basename, then call `send_message`:

```bash
URL=$(printf '%s' "${BASE}_en.mp3" | python3 -c "import sys,urllib.parse;print('https://macmini.ewe-hadar.ts.net/mer/'+urllib.parse.quote(sys.stdin.read()))")
```

Message template:

```
📰 새 메르 포스팅: {title}
🔗 원문: https://blog.naver.com/ranto28/{logno}
🎙️ EN audio: {URL}
```

### 4. Commit state (skip if `--test` or give-up)

- Append processed `logno` to `seen_log_nos`.
- If `bootstrap_all_seen`: also append every logno from step 1's response.
- Set `last_check` to current ISO-8601 local (+09:00).
- Write `STATE`.

### 5. Summary reply

Only send if N ≥ 1 (don't spam the channel with empty-run summaries). For manual `--test` invocations: always send the summary.

```
✅ mer-audio-digest: {N} post(s) processed.
• seen 총 {count}{ — test 모드, 상태 미갱신}?
```

## Retry Protocol (rate limit)

Determine `attempt` (default 1 on fresh invocation; read `attempt:` from the resume prompt when resumed).

| just attempted | delay | next attempt |
|---|---|---|
| 1 | 30 min | 2 |
| 2 | 60 min | 3 |
| 3 | 2 h | 4 |
| **4** | — | **give up** |

**Give up** (attempt 4 reached) — do NOT schedule more. Do NOT touch state. Announce:
```
⚠️ 오디오 생성 실패 (rate limit, 3회 재시도 후 포기)
📰 {title}
🔗 https://blog.naver.com/ranto28/{logno}
📝 본문 저장: /workspace/extra/webdav-data/public/mer/{BASE}.md
수동 재시도는 rate limit 풀린 뒤 `/mer-audio-digest` 재실행.
```

**Within limit** — call `mcp__nanoclaw__schedule_task`:
- `schedule_type: "once"`
- `schedule_value: <now + delay, local time, no Z suffix>`
- `context_mode: "isolated"`
- `target_group_jid: "dc:1495455110007099612"`
- `prompt:`
  ```
  Resume /mer-audio-digest audio generation.
  attempt: <next>
  test_mode: <true|false>
  notebook_id: <NB_ID>
  logno: <logno>
  date: <date>
  title: <title>

  Run the preamble, **rebuild BASE** from `date`/`logno`/`title` using the "Filename convention" helper, then re-run step 3b (NotebookLM) reusing notebook_id — skip create & source add, go straight to `generate audio` + `download` to `${MP3}`. On success: step 3c (send_message with URL-encoded MP3 URL), step 4 state (skip if test_mode), step 5 reply. On rate-limit: apply Retry Protocol with attempt=<next>. Never bash sleep.
  ```

Then reply with the task ID and delay, and exit.

## Failure modes

| Symptom | Action |
|---|---|
| Blog list fetch fails | Reply error, stop, no state change |
| Content crawl empty | Try postViewArea fallback; still empty → skip (no mark seen) |
| Rate-limited | Retry Protocol |
| Audio download fails | Retry `notebooklm download` once; still fails → announce without 🎙️ line, note the error |
| send_message fails | Surface the error; likely bot channel permission |

## Test

In the **podcast** channel (`requires_trigger=0`, plain text works):

```
/mer-audio-digest --test
```

Expected: latest post crawled → `{CONTENT}*_*.md` + `*_en.mp3` → one announce message with MP3 URL → `.mer_seen.json` unchanged.
