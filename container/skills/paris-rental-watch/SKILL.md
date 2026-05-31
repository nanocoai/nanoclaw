---
name: paris-rental-watch
description: Poll Paris real-estate sources (francezone bbs_2 + bbs_3 + pap.fr) for rentals matching ≥30m² · ≤1800€/월(환산) · 단독거주 · 시내+inner 근교, in TWO tracks — 장기(2026-06+ 입주) 또는 단기 여름(입주 ≤2026-08-31 & 미종료). Push alerts to discord_personal channel and auto-build interactive Leaflet+KML map (장기/단기 필터 포함). Triggers on `/paris-rental-watch`, `매물 체크`, or scheduled cron. Supports `--test` for dry runs. Replaces former `francezone-watch`.
allowed-tools: Bash(curl:*), Bash(python3:*), Bash(web-fetch:*), Bash(mkdir:*), Bash(printf:*), Bash(cat:*), Bash(rm:*), Bash(mv:*), Bash(sleep:*)
---

# Paris Rental Watch (multi-source)

**Default target channel:** `dc:1485303434541273220` (discord_personal). Cron lands here. Manual trigger uses current channel.

## Sources

| Source | Polling | Method | Notes |
|---|---|---|---|
| `francezone-bbs2` | 컨테이너 cron (이 skill) | curl + parse_francezone.py | 한인 게시판 "내집찾기" |
| `francezone-bbs3` | 컨테이너 cron (이 skill) | curl + parse_francezone.py | 한인 게시판 "내집찾기(II)", bbs_2와 구조 동일 |
| `pap` | 컨테이너 cron (이 skill) | `web-fetch` + parse_pap.py | Cloudflare 보호. 컨테이너의 `web-fetch` CLI가 `cf_detection`으로 challenge 감지 → 호스트의 `cf-fetch-server` sidecar(`http://host.docker.internal:8765`)로 자동 폴백하여 우회. 페이지네이션·파싱·pre-filter·실패 카운터 모두 컨테이너 안 STATE JSON 인라인 — 별도 호스트 헬퍼·핸드오프 파일 없음. |

## Invocation modes

| Mode | Detected by | Behavior |
|---|---|---|
| **Cron** | Prompt starts with `[SCHEDULED TASK]` | Full pipeline 모든 소스, 새 매물 알림, 상태 commit |
| **Manual** | 평문 메시지 (`/paris-rental-watch`, `매물 체크`) | Full pipeline, summary reply 항상 |
| **Test** | `--test` 플래그 | 소스별 가장 최근 1건만, 상태 변경 X, summary reply 항상 |

## Config

```
TARGET_JID  = dc:1485303434541273220
STATE       = /workspace/extra/webdav-data/.paris-rental-seen.json
LEGACY_STATE = /workspace/extra/webdav-data/.francezone_seen.json   # 첫 실행 시 자동 마이그레이션
PUBLIC_DIR  = /workspace/extra/webdav-data/public/paris-rental
PUBLIC_URL  = https://macmini.ewe-hadar.ts.net/paris-rental
LISTINGS    = $PUBLIC_DIR/listings.jsonl
HTML_OUT    = $PUBLIC_DIR/paris-realestate.html
KML_OUT     = $PUBLIC_DIR/paris-realestate.kml
SKILL_DIR   = /home/node/.claude/skills/paris-rental-watch

# 분류 2-트랙 (classify_rules.md 참조)
LONG_MOVE_IN_MIN = 2026-06-01   # 장기 track 최소 입주일
SHORT_TERM_END   = 2026-08-31   # 단기(여름) track 컷오프 — 시작 ≤ 이 날짜 & 미종료. 시즌 지나면 이 한 줄만 갱신
PRICE_MAX_EUR    = 1800         # 월세 환산 상한 (장·단기 공통)

# pap.fr (Source C) — direct fetch, container-side
PAP_BASE_URL          = https://www.pap.fr/annonce/locations-appartement-paris-75-g439
PAP_MAX_PAGES         = 50
PAP_PRICE_MAX         = 1800   # €/월 — over → host pre-filter rejects (LLM 정밀 분류는 그대로)
PAP_SURFACE_MIN       = 30     # m²  — under → host pre-filter rejects
PAP_FETCH_TIMEOUT_S   = 120    # web-fetch per-page budget (primary 60% + sidecar 40%)
PAP_PAGE_DELAY_S      = 2      # 페이지 사이 polite delay
PAP_FAILURE_THRESHOLD = 3      # 연속 실패 알림 임계 (Seed: failure_threshold default 3)
```

> 페치 실패 카운터(`pap_consec_failures`)·사유(`pap_last_failure_reason`)·
> 마지막 알림(`pap_failure_last_alert`)는 모두 STATE JSON 인라인 — 별도 파일 없음.

## 분류 규칙

**`./classify_rules.md` 참조** — 7축 (거래유형 추가, 매매 reject), 가격 단위 가이드, 판정 알고리즘 모두 거기 있음. 본 SKILL.md를 읽고 즉시 classify_rules.md도 함께 읽을 것.

**2-트랙 (장기/단기 여름).** 한 매물이 ① 장기(2026-06+ 입주, 월세 ≤1800€) 또는 ② 단기 여름(입주 ≤ `SHORT_TERM_END` & 종료 ≥ 오늘, 월세 **환산** ≤1800€) 중 하나라도 충족하면 통과. `term`(long/short/flex/unknown)은 알림·지도 배지 + 지도 필터에 쓰임. 가격은 단위(`price_unit`)에 맞춰 월세로 환산해 `price_eur`에 저장(weekly×4.345·nightly×30·flat 총액×30÷체류일). 날짜·환산 절차는 classify_rules.md “## 기간 판정” 참조.

## Preamble (실행마다 1회)

```bash
mkdir -p /workspace/extra/webdav-data/public/paris-rental/photos
```

## Workflow

### 0. State 마이그레이션 (1회 자동)

```python
import os, json
LEGACY = "/workspace/extra/webdav-data/.francezone_seen.json"
STATE  = "/workspace/extra/webdav-data/.paris-rental-seen.json"
if os.path.exists(LEGACY) and not os.path.exists(STATE):
    o = json.load(open(LEGACY))
    json.dump({
        "seen_post_ids": [f"francezone-bbs2:{p}" for p in o.get("seen_post_ids", [])],
        "last_check": o.get("last_check"),
        "last_check_by_source": {
            "francezone-bbs2": o.get("last_check"),
            "francezone-bbs3": None,
            "pap": None,
        },
        "rate_limit_attempt": 0,
        "backfilled_at": o.get("backfilled_at"),
        "pap_failure_last_alert": None,
        # AC 2 — pap 실패 카운터/사유는 더 이상 별도 파일이 아니라 STATE 내부.
        "pap_consec_failures": 0,
        "pap_last_failure_reason": None,
        # Content de-dup — fingerprints of units already surfaced (zip|area|
        # price|rooms). Seeded from listings.jsonl on first run (Section 1).
        "seen_fingerprints": [],
        "fingerprints_backfilled_at": None,
    }, open(STATE,"w"), ensure_ascii=False, indent=2)
    os.rename(LEGACY, LEGACY + ".bak")
```

> 기존 STATE에 `pap_consec_failures` / `pap_last_failure_reason` 키가 없는
> 경우(AC 2 이전 install) Section 1 로드 직후 `state.setdefault(...)` 로 0/None
> 시드. 추가 마이그레이션 코드 불필요.

### 1. State 로드

```python
import sys
SKILL_DIR = "/home/node/.claude/skills/paris-rental-watch"
if SKILL_DIR not in sys.path:
    sys.path.insert(0, SKILL_DIR)
from dedup import fingerprint_of  # content de-dup (unit-tested: test_dedup.py)

LISTINGS = "/workspace/extra/webdav-data/public/paris-rental/listings.jsonl"

state = json.load(open(STATE))
seen = set(state["seen_post_ids"])
# AC 2 — old install이면 키 없을 수 있어 안전 시드
state.setdefault("pap_consec_failures", 0)
state.setdefault("pap_last_failure_reason", None)
state.setdefault("pap_failure_last_alert", None)
# 콘텐츠 de-dup 상태 (old install 안전 시드)
state.setdefault("seen_fingerprints", [])
state.setdefault("fingerprints_backfilled_at", None)
seen_fps = set(state["seen_fingerprints"])

# One-time backfill — seed fingerprints from the existing listings log so a
# repost of an already-listed unit (new post_id) is recognised on the very
# first run after this feature ships, not re-alerted. Idempotent via the flag.
if not state["fingerprints_backfilled_at"]:
    try:
        with open(LISTINGS) as f:
            for line in f:
                line = line.strip()
                if line:
                    fp = fingerprint_of(json.loads(line))
                    if fp:
                        seen_fps.add(fp)
    except FileNotFoundError:
        pass
    state["fingerprints_backfilled_at"] = now_iso()
```

> **Content de-dup (재게시 차단).** francezone 중개업자는 같은 집을 며칠마다
> 새 post_id로 재게시한다(끌어올리기). `seen_post_ids`는 ID만 보므로 매번
> "새 매물"로 알림이 나갔다. 이제 `dedup.fingerprint_of` 가 `zip|면적|가격|방수`
> 지문을 만들어 **이미 알린 매물의 재게시·교차게시(bbs_2↔bbs_3, pap↔francezone)
> 를 알림·지도에서 모두 제외**한다. zip/면적/가격 중 하나라도 없으면 지문 None →
> 콘텐츠 dedup 생략(ID-only로 폴백, 약한 근거로 다른 집을 합치지 않음).

### 2. 소스별 polling

#### Source A — francezone-bbs2

```bash
curl -s -A "Mozilla/5.0" "https://www.francezone.com/bbs/list.html?table=bbs_2" \
  | python3 /home/node/.claude/skills/paris-rental-watch/parse_francezone.py list \
  > /tmp/fz_bbs2_list.json
```

각 post에 대해 `nid = f"francezone-bbs2:{post_id}"` → seen 에 있으면 skip, 없으면 detail fetch + classify.

#### Source B — francezone-bbs3

```bash
curl -s -A "Mozilla/5.0" "https://www.francezone.com/bbs/list.html?table=bbs_3" \
  | python3 /home/node/.claude/skills/paris-rental-watch/parse_francezone.py list \
  > /tmp/fz_bbs3_list.json
```

`nid = f"francezone-bbs3:{post_id}"` 기준 seen 비교. parse_francezone.py 그대로 재사용.

#### Source C — pap.fr (direct via `web-fetch`)

pap.fr is Cloudflare-protected. The container's `web-fetch` CLI tags every
primary-path response with a `cf_detection` verdict and, when it sees a
challenge, transparently falls back to the host-side `cf-fetch-server`
sidecar at `http://host.docker.internal:8765/fetch` (Sub-AC 2.3 of the
web-fetch Seed; see `container/skills/web-fetch/SKILL.md`). The skill
therefore paginates the listings index in-process — no host helpers, no
staging file.

The webshare residential proxy credentials live ONLY in the host launchd
plist (`host-helpers/cf-fetch-server/launchd.plist.template`); they never
enter the container env. This skill does NOT need to know the proxy URL.

```python
import json, subprocess, sys, time

# AC 5 — make `pap_failure_log` (sibling module) importable. The skill
# directory is not on sys.path by default since the LLM-driven block runs
# from /workspace, not from SKILL_DIR. Inserting it once at the top is
# safe and idempotent — duplicate entries are harmless. We re-bind
# SKILL_DIR locally so this Section C block stays runnable in isolation
# (the same constant is documented in the Config block above).
SKILL_DIR = "/home/node/.claude/skills/paris-rental-watch"
if SKILL_DIR not in sys.path:
    sys.path.insert(0, SKILL_DIR)
from pap_failure_log import (
    log_pap_fetch_failure,
    reset_pap_fetch_counter,
)
from pap_prefilter import prefilter_pap_card  # evidence-only drop (unit-tested)

PAP_BASE_URL          = "https://www.pap.fr/annonce/locations-appartement-paris-75-g439"
PAP_MAX_PAGES         = 50
PAP_PRICE_MAX         = 1800   # €/월 (over → host pre-filter rejects)
PAP_SURFACE_MIN       = 30     # m²  (under → host pre-filter rejects)
PAP_FETCH_TIMEOUT_S   = 120
PAP_PAGE_DELAY_S      = 2
PAP_FAILURE_THRESHOLD = 3      # Seed: failure_threshold default 3
# pap.fr/Cloudflare가 CF 통과 후에도 가끔 stripped (200 + valid title + html≈
# 30-65KB + 0 cards) 페이지를 반환. 같은 IP에서도 무작위로 발생해 ~20% 실패율을
# 만든다. page 1에서 cards=[]이면 재시도하면 거의 항상 정상 페이지 회수 (재시도
# 마다 sidecar가 새 탭/IP 사용). page>1의 cards=[]는 진짜 pagination 끝이라 그대로 break.
PAP_PAGE1_EMPTY_BACKOFFS_S = (2, 4, 6)

pap_pages_done = 0
pap_total_cards = 0
pap_pre_filtered_out = 0
pap_skipped_seen = 0
pap_failure_reason = None
pap_failed_first_page = False
pap_new_listings = []  # 후속 LLM 분류 대상

def _fetch_pap_page_cards(page_idx: int):
    """Returns (status, cards_or_None, reason).
    status: 'ok' | 'fetch_fail' | 'parse_fail' | 'timeout'."""
    url = PAP_BASE_URL if page_idx == 1 else f"{PAP_BASE_URL}-{page_idx}"
    try:
        proc = subprocess.run(
            ["web-fetch", "--output", "html",
             "--timeout", str(PAP_FETCH_TIMEOUT_S),
             "--quiet", url],
            capture_output=True, text=True,
            timeout=PAP_FETCH_TIMEOUT_S + 15,
        )
    except subprocess.TimeoutExpired as e:
        return ('timeout', None, f"page {page_idx} subprocess timeout: {e}")
    if proc.returncode != 0:
        return ('fetch_fail', None,
                f"page {page_idx} web-fetch rc={proc.returncode}: "
                f"{(proc.stderr or '').strip()[:200]}")
    parsed = subprocess.run(
        ["python3", f"{SKILL_DIR}/parse_pap.py", "list"],
        input=proc.stdout, capture_output=True, text=True, timeout=20,
    )
    if parsed.returncode != 0:
        return ('parse_fail', None,
                f"page {page_idx} parse_pap rc={parsed.returncode}: "
                f"{(parsed.stderr or '').strip()[:200]}")
    try:
        cards = json.loads(parsed.stdout or "[]")
    except json.JSONDecodeError as e:
        return ('parse_fail', None, f"page {page_idx} parse_pap JSON decode: {e}")
    return ('ok', cards, '')

for page in range(1, PAP_MAX_PAGES + 1):
    status, cards, reason = _fetch_pap_page_cards(page)

    # Page 1 stripped-page retry (CF-cleared but content stripped by anti-bot).
    if page == 1 and status == 'ok' and not cards:
        for backoff in PAP_PAGE1_EMPTY_BACKOFFS_S:
            time.sleep(backoff)
            status, cards, reason = _fetch_pap_page_cards(1)
            if status != 'ok' or cards:
                break

    if status != 'ok':
        pap_failure_reason = reason
        if page == 1:
            pap_failed_first_page = True
        break

    if not cards:
        if page == 1:
            # All retries exhausted, still empty → real failure.
            pap_failure_reason = (
                f"page 1 returned 0 cards after "
                f"{1 + len(PAP_PAGE1_EMPTY_BACKOFFS_S)} attempts (stripped-page anti-bot)"
            )
            pap_failed_first_page = True
        break  # page > 1 with empty = end of pagination

    pap_pages_done += 1
    pap_total_cards += len(cards)

    for c in cards:
        nid = f"pap:{c['pap_id']}"
        if nid in seen:
            pap_skipped_seen += 1
            continue
        # Conservative pre-filter (pap_prefilter.prefilter_pap_card, unit-tested):
        # drop ONLY on positive evidence — price known & >max, or surface known
        # & <min. Unknown (None) price/surface is KEPT and handed to the LLM 7축
        # classifier (3b). rooms is NOT a drop axis on its own — a 1-pièce with
        # unparsed surface must reach the classifier, not be silently dropped.
        price = c.get("price_eur")
        surface = c.get("surface_m2")
        rooms = c.get("rooms")
        keep, _drop_reason = prefilter_pap_card(
            c, price_max=PAP_PRICE_MAX, surface_min=PAP_SURFACE_MIN)
        if not keep:
            pap_pre_filtered_out += 1
            continue
        # Geocode (Paris centroid fallback on failure)
        try:
            g = json.loads(subprocess.check_output(
                ["python3", f"{SKILL_DIR}/geocode.py",
                 c.get("location_text") or "Paris"],
                timeout=15,
            ))
        except Exception:
            g = {"lat": 48.8566, "lng": 2.3522, "source": "fallback"}
        pap_new_listings.append({
            "source": "pap",
            "post_id": c["pap_id"],
            "namespaced_id": nid,
            "title": c["title"],
            "url": c["detail_url"],
            "fetched_at": now_iso(),
            "post_date": "",
            "price_eur_card": price,
            "surface_m2_card": surface,
            "rooms_card": rooms,
            "tags": c.get("tags", []),
            "location_text": c.get("location_text", ""),
            "description": c.get("description", ""),
            "photo_url": c.get("photo_url", ""),
            "lat": g["lat"], "lng": g["lng"],
            "geocode_source": g["source"],
        })

    time.sleep(PAP_PAGE_DELAY_S)

# Failure tracking lives on STATE (no separate file).
# - Got at least one page of cards → reset counter.
# - Got nothing AND failed → log_pap_fetch_failure (counter++, structured log on
#   stderr, NO Discord here — Section 6 alerts on threshold).
# - Got nothing AND simply no listings (last page reached) → also reset (the
#   site returned a real, healthy "empty" — cf-fetch-server is fine).
#
# AC 5: a single ok=false tick must produce ONLY a structured log line. The
# Discord card lives in Section 6 and only fires when consec ≥ threshold AND
# the 24h dedupe is clear. `pap_failure_log` encapsulates the contract so
# both the log shape and the dedupe decision are unit-tested
# (test_pap_failure_log.py — 18 cases). The helper was already imported at
# the top of this block.
if pap_pages_done > 0:
    reset_pap_fetch_counter(state)
elif pap_failed_first_page or pap_failure_reason:
    log_pap_fetch_failure(
        pap_failure_reason,
        state=state,
        threshold=PAP_FAILURE_THRESHOLD,
        now_iso=now_iso(),
    )
else:
    reset_pap_fetch_counter(state)

# 3b/3c는 francezone과 동일 — 각 entry에 대해 LLM 7축 분류 후 알림/listings 추가.
for entry in pap_new_listings:
    nid = entry["namespaced_id"]
    verdict = classify(entry)  # LLM, classify_rules.md 7축
    if verdict["verdict"] == "reject":
        seen.add(nid); continue
    process_and_alert(entry, verdict)
    seen.add(nid)
```

`SKILL_DIR` is the Config block constant (`/home/node/.claude/skills/paris-rental-watch`).

**Failure resilience.** A single failed cron tick must NOT alert — the
sidecar is allowed transient hiccups (proxy rotation, queue-full, DNS).
Failures are silently logged; only `pap_consec_failures >= PAP_FAILURE_THRESHOLD`
(default 3) triggers Section 6's Discord notice.

### 3. 분류 + 처리 (소스별 공통)

각 새 글 `p`에 대해:

**3a. (francezone만) 상세 fetch**
```bash
curl -s -A "Mozilla/5.0" "https://www.francezone.com/bbs/view.html?idxno=${POST_ID}" \
  | python3 /home/node/.claude/skills/paris-rental-watch/parse_francezone.py detail \
  > /tmp/fz_detail.json
```

본문 비어있으면 그 글 skip (seen 추가 X, 다음 cron 재시도).

**3b. LLM 분류 (classify_rules.md 7축)**

본문 + 제목 (또는 pap 카드의 title+description+tags) 읽고 거래유형 / 단기·장기 / 셰어·단독 / 면적 / 가격 / 입주 / 위치 평가. 결과 JSON 출력.

`verdict == "reject"` → seen 추가만, listings/알림 X.

**3c. 통과/모호 시 처리**

```python
import subprocess

# 콘텐츠 de-dup 가드 — 이미 알린 매물의 재게시/교차게시면 여기서 끝.
# 지문은 분류 결과(canonical zip/면적/가격/방수)로 계산해 소스 무관하게 일치.
dedup_fp = fingerprint_of({
    "zip_or_arr": verdict["zip_or_arr"],
    "area_m2":    verdict["area_m2"],
    "price_eur":  verdict["price_eur"],
    "rooms":      verdict.get("rooms"),
})
if dedup_fp and dedup_fp in seen_fps:
    # 같은 집을 이미 알림+지도에 올림 → post_id만 seen 처리하고 알림/listings 생략.
    sys.stderr.write(json.dumps({
        "event": "paris-rental-watch.dedup.skip",
        "fingerprint": dedup_fp, "namespaced_id": nid, "source": source,
    }, ensure_ascii=False, separators=(",", ":")) + "\n")
    seen.add(nid)
    continue   # 다음 매물로 (이 글은 알림/지도 추가 안 함)
if dedup_fp:
    seen_fps.add(dedup_fp)

# 지오코딩
loc_input = location_text or zip_or_arr or "Paris"
coords = json.loads(subprocess.check_output(
    ["python3", "/home/node/.claude/skills/paris-rental-watch/geocode.py", loc_input]))

# 사진 mirror (francezone만; pap은 cdn.pap.fr 안정적이라 mirror 안 함)
photo_url = ""
if image_urls and source.startswith("francezone"):
    fname = f"{source}_{post_id}_0.jpg"
    subprocess.run(["curl","-s","-A","Mozilla/5.0","-o",
                    f"{PUBLIC_DIR}/photos/{fname}", image_urls[0]])
    photo_url = f"{PUBLIC_URL}/photos/{fname}"
elif image_urls:
    photo_url = image_urls[0]

listing = {
    "source": source,                     # "francezone-bbs2" | "francezone-bbs3" | "pap"
    "post_id": post_id,
    "namespaced_id": nid,
    "title": title,
    "url": url,
    "fetched_at": now_iso(),
    "post_date": post_date,
    "deal_type": verdict["deal_type"],
    "term": verdict["term"],
    "occupancy": verdict["occupancy"],
    "area_m2": verdict["area_m2"],
    "price_eur": verdict["price_eur"],
    "price_unit": verdict["price_unit"],
    "move_in": verdict["move_in"],
    "location_text": verdict["location_text"],
    "zip_or_arr": verdict["zip_or_arr"],
    "lat": coords["lat"], "lng": coords["lng"],
    "geocode_source": coords["source"],
    "photo_url": photo_url,
    "all_photos": image_urls[:5],
    "verdict": verdict["verdict"],
    "ambiguous_axes": verdict["ambiguous_axes"],
    "raw_body_excerpt": (body or description)[:500],
}

with open(LISTINGS, "a") as f:
    f.write(json.dumps(listing, ensure_ascii=False) + "\n")

# Discord 알림
flag = "✅" if verdict["verdict"] == "pass" else "⚠️"
src_badge = {"francezone-bbs2":"💬 bbs2","francezone-bbs3":"💬 bbs3","pap":"🇫🇷 pap"}[source]
term_badge = {"long":"🏠 장기","short":"⛱️ 단기","flex":"🔁 유연"}.get(verdict["term"], "❓기간미상")
# 단기(weekly/nightly/flat)는 환산값임을 표시
_pu = verdict.get("price_unit", "monthly")
_price = verdict["price_eur"]
price_str = (f"{_price}€/월" if _pu in ("monthly", None) or _price is None
             else f"≈{_price}€/월(환산·{_pu})")
card = f"""{flag} 새 매물 — {title} [{src_badge}] [{term_badge}]
📍 {verdict['location_text']} ({verdict['zip_or_arr']})  |  {verdict['area_m2'] or '?'}m²  |  {price_str}
🗓️ 입주: {verdict['move_in'] or '미기재'} · 단/장: {verdict['term']} · 단독/셰어: {verdict['occupancy']}
📷 {photo_url or '사진 없음'}
🔗 원글: {url}
🗺️ 지도: {PUBLIC_URL}/paris-realestate.html#{nid}
🌍 Google Maps: https://www.google.com/maps/search/?api=1&query={coords['lat']},{coords['lng']}
📂 KML: {PUBLIC_URL}/paris-realestate.kml"""
if verdict["ambiguous_axes"]:
    card += f"\n\n⚠️ 모호: {', '.join(verdict['ambiguous_axes'])}"

# mcp__nanoclaw__send_message로 발송 (target_group_jid=TARGET_JID)
seen.add(nid)
```

### 4. 지도 재빌드 (새 매물 1건 이상 추가됐을 때만)

```bash
python3 /home/node/.claude/skills/paris-rental-watch/render_map.py \
  "$LISTINGS" "$HTML_OUT" "$KML_OUT" "$(date -Iseconds)"
```

### 5. State commit

```python
state["seen_post_ids"] = sorted(seen, reverse=True)
state["seen_fingerprints"] = sorted(seen_fps)   # 콘텐츠 de-dup 지문 영속화
state["last_check"] = now_iso()
state["last_check_by_source"][source] = now_iso()  # 각 소스 처리 후
json.dump(state, open(STATE,"w"), ensure_ascii=False, indent=2)
```

### 6. pap.fr 페일오버 알림 체크

state 기반 (별도 파일 없음). 임계 = `PAP_FAILURE_THRESHOLD` (기본 3, Seed
ontology). 연속 실패가 임계를 넘으면 24h dedupe 후 Discord에 알림.

`pap_failure_log.evaluate_pap_alert` returns `(should_alert, message)` —
purely a decision function, no side-effects. SKILL.md owns the actual
delivery via `mcp__nanoclaw__send_message` and then calls
`mark_pap_alert_sent` so the dedupe stamp + a `paris-rental-watch.pap.fetch.alert`
structured-log record land on stderr (matching the per-tick failure event,
both grep-able by `event` prefix).

```python
# Helper already on sys.path (Section C top).
from pap_failure_log import evaluate_pap_alert, mark_pap_alert_sent

should_alert, alert_msg = evaluate_pap_alert(
    state=state,
    threshold=PAP_FAILURE_THRESHOLD,
    now_iso=now_iso(),
)
if should_alert:
    # Deliver via the standard messaging tool — TARGET_JID is the Seed's
    # `alert_channel` (dc:1485303434541273220).
    send_message(TARGET_JID, alert_msg)
    mark_pap_alert_sent(state, now_iso())
    json.dump(state, open(STATE, "w"), ensure_ascii=False, indent=2)
```

> **Single-failure contract.** Section C already calls
> `log_pap_fetch_failure` on every web-fetch ok=false / rc≠0, which writes
> a single-line JSON to stderr (`event="paris-rental-watch.pap.fetch.failure"`)
> and increments `pap_consec_failures`. Section 6 above is the ONLY place
> that decides whether to surface the failure to the user. So:
>
> - `consec_failures < 3` → log line only, no Discord.
> - `consec_failures >= 3` AND no recent alert → log + alert + dedupe stamp.
> - `consec_failures >= 3` AND alert in last 24h → log only (dedupe).
> - 다음 성공 → counter reset (dedupe stamp 보존, 깜빡이 보호).

## Bootstrap (state 비어있을 때)

각 소스 가장 최근 1건만 처리, 나머지는 mark seen. (백필 후엔 이미 seed 돼있어 정상 모드로 진입)

## Failure modes

| Symptom | Action |
|---|---|
| francezone list fetch 실패 | 해당 소스 skip, 다른 소스 진행 |
| francezone detail body 비어있음 | 그 글 skip (seen 추가 X, 다음 cron 재시도) |
| pap web-fetch rc≠0 / `ok=false` (1페이지 실패) | pap source silent skip · `log_pap_fetch_failure(...)` (counter++, 1-line JSON `event=paris-rental-watch.pap.fetch.failure` to stderr, NO Discord) · 다른 소스 진행 |
| pap web-fetch rc≠0 (N≥2페이지 실패) | 이미 받은 카드는 처리, 페이지네이션 중단 · 카운터 reset (pages_done>0 → 사이드카는 살아있음) |
| pap parse_pap.py rc≠0 / JSON decode 실패 | pap source silent skip · `log_pap_fetch_failure(...)` (counter++, structured log only) |
| pap `cf_detection.is_challenge=true` (sidecar 폴백 후에도) | web-fetch 자체가 envelope `ok=false` 반환 → `log_pap_fetch_failure(...)` 로 실패 카운트 |
| `pap_consec_failures ≥ PAP_FAILURE_THRESHOLD` (기본 3) | Section 6 `evaluate_pap_alert` → Discord 카드 1회 + `mark_pap_alert_sent` (event=`paris-rental-watch.pap.fetch.alert` 별도 로그). 24h dedupe. 다음 성공 시 카운터 reset (dedupe 스탬프는 보존 — 깜빡이 보호) |
| Geocode 모두 fallback (Paris centroid) | listing 넣되 location_text는 정확히, 사용자가 수정 가능 |
| Photo mirror 실패 | photo_url=원본 URL fallback |
| 재게시/교차게시 (같은 집, 새 post_id) | `dedup.fingerprint_of` 지문(`zip\|면적\|가격\|방수`)이 `seen_fps`에 있으면 post_id만 seen 처리, 알림·listings 생략 (`event=paris-rental-watch.dedup.skip` 1-line 로그). 지도도 render 시 지문 1개당 최신 1건만 표시 |
| 지문 불가 (zip/면적/가격 중 결측) | 콘텐츠 dedup 생략 → ID-only 폴백 (약한 근거로 다른 집 합치지 않음) |

## Test 모드

```
/paris-rental-watch --test
```

각 소스별 가장 최근 1건만 평가 (하지만 state는 안 건드림). pap의 경우
`web-fetch`로 1페이지만 받아 첫 1건만 처리 (`PAP_MAX_PAGES = 1` 동등). 실패
카운터·`last_check_by_source`도 건드리지 않음.

## 스케줄 등록 (한 번만 — 기존 cron 재사용)

기존 task `task-fz-1778180506-4811df` 의 prompt만 SQL UPDATE:

```sql
UPDATE scheduled_tasks
   SET prompt = '[SCHEDULED TASK] /paris-rental-watch'
 WHERE id = 'task-fz-1778180506-4811df';
```
