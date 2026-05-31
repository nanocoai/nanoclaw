# Paris-rental-watch 분류 규칙 (7축, 안전모드)

대상 사용자: 30대 부부, 단독 거주(셰어 X), 30m² 이상, 파리 시내 또는 RER 30분 이내, **임대만(매매 X).**

**두 트랙 병행 (둘 중 하나라도 충족하면 통과):**

| 트랙 | 입주/기간 | 가격 | 비고 |
|---|---|---|---|
| **장기 (long)** | 2026-06-01 이후 입주 (또는 즉시입주 + 게시일 6월+) | 월세 ≤1800€ | 기존 기준 그대로 |
| **단기 (short, 여름)** | 입주(시작) ≤ **2026-08-31** & 아직 안 끝남(종료 ≥ 오늘 또는 종료 미명시) | **월세 환산** ≤1800€ | 5~8월 여름 단기·sous-location |

> **`SHORT_TERM_END = 2026-08-31`** — 여름 시즌 컷오프. 이 시즌이 지나면 이 날짜만 갱신하면 됨 (SKILL.md Config와 동일 상수). 면적(≥30㎡)·단독거주·위치·거래유형(임대) 기준은 **두 트랙 공통**.

LLM이 `title + body`(또는 pap.fr 카드 데이터)를 읽고 다음 JSON 출력:

```json
{
  "verdict": "pass | ambiguous | reject",
  "deal_type": "rent | sale | unknown",
  "term": "long | short | flex | unknown",
  "occupancy": "solo | share | unknown",
  "area_m2": <number|null>,
  "rooms": "T1 | T2 | T3 | T4+ | unknown",
  "price_eur": <number|null>,
  "price_unit": "monthly | weekly | nightly | flat | unknown",
  "move_in": "YYYY-MM-DD | flexible | null",
  "location_text": "<사람이 읽기 좋은 위치 설명>",
  "zip_or_arr": "75015 | 92100 | …",
  "meuble": "meuble | non | unknown",
  "ambiguous_axes": ["axis_name", …]
}
```

## 7축 판정표

| 축 | pass ✅ | ambiguous ⚠️ | reject ❌ |
|---|---|---|---|
| **거래유형 (deal_type)** | 임대/loyer/location/rent/월세 명시 | 미명시 | **매매·[매매]·매매//·매매한·매매하실·매매합니다·vente·à vendre·for sale·분양·매수·매도** |
| **단기/장기 (term)** | 장기임대·1년 계약·bail meublé·bail vide·long-term·12개월·1년 이상 → `long` · **또는** 단기·여름 단기·sous-location·sublet·N개월/N주·par semaine·날짜범위(예 "6/1~8/31") → `short` — **둘 다 허용** (트랙만 결정, term 자체로는 reject 안 함) | 중/단기·중장기·단/장기 → `flex` · 미명시 → `unknown` | **1주 미만 초단기 관광용**만 (airbnb 1박·par nuit 단발·체류 <7일 명시) — 거주용 아님 |
| **셰어/단독 (occupancy)** | 아파트 전체·집 전체·단독 사용·독립 세대·whole apartment | 미명시 | 꼴로·colocation·코로카시옹·룸쉐어·룸메·셰어·여학생만·여자만·남학생만·남자만·여성 1분·여자 1분·남자 1명·여성 전용·여자 전용·남자 전용·학생 전용·방 1·방1·방 한 칸·방하나·개인방·room only·주인 거주·본인 거주중 |
| **면적 (area_m2)** | 명시적 ≥30m² (또는 ≥9평 ≈ 30m²) | 미기재 + T2/T3/2P/3P/투룸/2 chambres/3 chambres 명시 | 명시적 <30m² · OR Studio/스튜디오/원룸/T1/메블레 1P/스튀데트/1.5룸 명시 (면적 없어도) |
| **가격 (price_eur — 월세 환산)** | **월세 환산** ≤1800€ — monthly는 그대로, weekly×4.345 · nightly×30 · flat(총액×30÷체류일)로 환산 (charges 포함/제외 무관). `price_eur`엔 **환산값**, `price_unit`엔 **원 단위** 저장 | 가격 미기재·"협의"·단가 단위 모호 | 월세 환산 >1800€ |
| **기간·입주 (move_in)** | 트랙별 판정 — **아래 “## 기간 판정 (장기/단기 2-트랙)” 참조** (장기: 2026-06+ / 단기: 시작 ≤ SHORT_TERM_END & 미종료) | 날짜 미기재·"협의"·"flexible" | 두 트랙 모두 불충족 (예: 9월 이후 시작 단기, 또는 6월 이전 시작 장기) |
| **위치 (location)** | 75001~75020 또는 inner 92/93/94 (Boulogne, Neuilly, Levallois, Issy, Vanves, Malakoff, Montrouge, Ivry, Saint-Mandé, Vincennes, Saint-Ouen, Clichy, Asnières, Puteaux, Suresnes, Saint-Cloud, Charenton, Pantin, Aubervilliers, Bagnolet) | RER A/B/C/D/E 직통 30분 이내 외곽 (Vitry, Villejuif, Rosny, Créteil, Champigny, Bagneux, Cachan, Maisons-Alfort 등) | 우편번호 77/78/91/95 · 외곽 + RER 환승 필요 또는 30분 초과 (Versailles 외곽, Saint-Denis 외곽, Drancy 외곽 등) |

## 기간 판정 (장기/단기 2-트랙)

`SHORT_TERM_END = 2026-08-31`. 오늘 날짜 기준으로 판정 (cron 실행일).

매물의 시작(입주)일·종료일을 본문/제목에서 추출한다 (예: "6/1 입주", "7~8월", "6월 1일~8월 31일", "즉시입주", "3개월"). 그 다음 **트랙 결정 → 적격성 판정** 순서:

```
1) 트랙 결정 (term 기반):
   - term == long              → 장기 track
   - term == short             → 단기 track
   - term == flex / unknown    → 두 track 모두 시도 (하나라도 pass면 pass)

2) 장기 track 적격성:
   - move_in ≥ 2026-06-01 (ISO 명시)            → pass
   - "즉시입주"/"즉시" + 게시일이 6월 이후        → pass
   - move_in < 2026-06-01 명시 (예 "5월 입주")    → 장기로는 reject (단기 track 재시도)
   - move_in 미기재/협의/flexible                 → ambiguous (장기 track)

3) 단기 track 적격성:
   - 시작일 ≤ 2026-08-31  AND  (종료일 ≥ 오늘  OR  종료일 미명시)  → pass
   - 시작일 > 2026-08-31 (가을·9월 이후 시작)                       → reject
   - 종료일 < 오늘 (이미 끝난 단기, 예 "4/1~4/30")                  → reject
   - 날짜 모두 모호/미기재                                          → ambiguous

4) 종합:
   - 어느 한 track이라도 pass            → 해당 매물 통과(pass), term은 그 track 값
   - pass 없고 ambiguous 있음            → ambiguous
   - 두 track 모두 reject                → reject
```

예시 (오늘 = 2026-05-29):

```
"7~8월 두 달 단기, 6/30 입주, 1300€/월, 35m² 2P"   → 단기 pass (시작 6/30 ≤ 8/31, 종료 8월≥오늘)
"여름 sous-loc 6/1~8/31, 400€/주, 40m²"            → 단기 pass (월환산 1738 ≤1800)
"단기 5/8~5/31, 1200€, 32m²"                       → 단기 pass (종료 5/31 ≥ 5/29)
"단기 4/1~4/30 ..."                                → reject (이미 종료)
"9/1부터 1년, 1500€/월, 38m²"                       → 장기 pass (9월 입주는 6월 이후)
"즉시입주 장기 1600€/월, 40m² (게시 5/20)"          → 장기 ambiguous→pass (즉시+게시 5월? 6월 이전 즉시는 장기 reject지만 단기 track 시도: 시작 즉시≤8/31, 종료 미명시 → 단기 pass)
"airbnb 2박 90€/박 22m² studio"                     → reject (면적·1주미만 관광·T1)
```

## 가격 단위 판별 가이드

| 표기 | price_unit | price_eur (= 월세 환산) |
|---|---|---|
| `1500€/월`, `1500 € / mois`, `월세 1500€`, `월 1500유로`, `loyer 1500`, `1500 CC`, `charges comprises`, `한달 1500` | **monthly** | 1500 (그대로) |
| `400€/주`, `par semaine`, `/주`, `/sem` | **weekly** | round(400 × 4.345) = 1738 |
| `90€/박`, `90€/일`, `1박 90`, `par nuit`, `par jour`, `nuitée` | **nightly** | round(90 × 30) = 2700 |
| `6주 1400€`, `(N박/N주) 총액`, `총 1400`, "X주간 총 1400" | **flat** | round(1400 × 30 ÷ 체류일). 6주=42일 → round(1400×30/42)=1000. 체류일 모르면 null + ambiguous |
| 숫자 + `€/EUR/유로`만 (단위 키워드 없음) | **unknown** | null → ambiguous |
| `보증금 1500`, `caution 1500`, `예약시 입금`, `dépôt de garantie` | 무시 (보증금) | 가격 추출 안 함 |

환산 상수: **weekly ×4.345** (30.44/7), **nightly ×30**, **flat = 총액×30÷체류일**. 본문에 단위 다른
가격이 여럿이면 **거주 임대료로 확신되는 값**만 환산해 `price_eur`로. 없으면 null + ambiguous.
환산값이 ≤1800이면 가격 축 pass, >1800이면 reject (장·단기 동일 임계).

## 방수 (rooms) 추출 가이드

`rooms` 필드는 사이드바 지도 필터의 한 축(T1 / T2 / T3 / T4+ / unknown)이며, 판정(verdict) 결과에는 영향을 주지 않는 **메타데이터 추출**이다. 본문/제목에서 다음 패턴을 찾아 매핑한다.

### 매핑 표

| 출력 값 | 매칭 키워드 (대소문자 무시, 다이아크리틱 무시) |
|---|---|
| **T1** | `T1`, `T 1`, `1P`, `1 pièce`, `1 piece`, `studio`, `스튜디오`, `원룸`, `메블레 1P`, `스튀데트`, `studette`, `1.5룸` |
| **T2** | `T2`, `T 2`, `2P`, `2 pièces`, `2 chambres`, `1 chambre + 1 séjour`, `투룸`, `2룸`, `방 2`, `방2`, `1 bedroom`, `1BR`, `F2`  |
| **T3** | `T3`, `T 3`, `3P`, `3 pièces`, `2 chambres + séjour`, `쓰리룸`, `3룸`, `방 3`, `방3`, `2 bedrooms`, `2BR`, `F3` |
| **T4+** | `T4`, `T5`, `T6`, `T 4`, `4P`, `5P`, `4 pièces`, `4 pieces`, `5 pièces`, `4 chambres+`, `포룸`, `4룸 이상`, `방 4`, `방4`, `방 5`, `3 bedrooms`, `3BR+`, `F4`, `F5`, `duplex 4P` |
| **unknown** | 위 키워드 어디에도 매칭 안 됨, 또는 면적만 명시되고 방수 모호 (예: `40m²` 단독) |

### 우선순위 (충돌 시)

1. **명시적 T-코드 (T1/T2/T3/...)** > 한국어 단어 > 면적 추론
2. 동일 listing에 여러 표기가 있으면 **가장 큰 값** 채택 (예: 본문 "T2 또는 T3" → T3)
3. T4 이상은 모두 **T4+** 로 합쳐서 출력 (T4, T5, duplex grand 등 단일 버킷)
4. **studio + 메트로 이름 동시 출현** → studio 우선 (T1)
5. 면적만 있고 방수 키워드 전무하면 **추정 금지**, `unknown` 출력 (예: `45m²`만 → unknown, T2로 추정 X)

### 면적 축과의 관계

- 기존 `면적 (area_m2)` 판정 축은 그대로 유지: `<30m²` 또는 `studio/T1` 명시 시 reject.
- `rooms` 추출은 **reject 후에도 진행**하지 않고 (reject된 listing 은 listings.jsonl 에 안 들어감), pass/ambiguous 가 된 listing 에 대해서만 사이드바 필터용으로 채운다.
- T1 이 reject 인 이유: 30m² 미만 + 단독 거주 부적합. 따라서 listings.jsonl 에 들어가는 rooms 값은 사실상 `T2`, `T3`, `T4+`, `unknown` 4종.

### 한국어/프랑스어 혼용 예시

```
"파리 14구 T2 35m² 1300€/월 장기임대"        → rooms="T2"
"Studio 24m² Paris 11"                         → reject (T1 + 면적 미달); rooms 추출 생략
"3 pièces 65m² avec balcon 1750€"              → rooms="T3"
"방 3개 듀플렉스 80m² 1700€"                   → rooms="T3" (방 3 기준)
"T4 90m² 1800€ 4구 마레"                       → rooms="T4+"
"40m² 아파트 1500€/월 11구"                   → rooms="unknown" (방수 키워드 없음)
"1 chambre + salon 2P 40m² 1400€"              → rooms="T2"
```

## 가구 유무 (meublé) 추출 가이드

`meuble` 필드는 사이드바 지도 필터의 한 축(meuble / non / unknown 3-state)이며, **판정(verdict) 결과에는 영향을 주지 않는 메타데이터 추출**이다. 30대 부부 거주 목적상 가구 있음/없음 둘 다 허용되므로 reject/ambiguous 축으로 다루지 않고, 사이드바에서 사용자가 후필터링할 수 있도록 값만 채운다.

### 매핑 표

| 출력 값 | 매칭 키워드 (대소문자 무시, 다이아크리틱 무시) |
|---|---|
| **meuble** | `meublé`, `meuble`, `meublée`, `meublees`, `bail meublé`, `location meublée`, `furnished`, `fully furnished`, `가구 포함`, `가구포함`, `풀옵션`, `풀퍼니시드`, `옵션 포함`, `옵션포함`, `메블레`, `세미 메블레`, `semi-meublé` |
| **non** | `non meublé`, `non-meublé`, `vide`, `non meublée`, `bail vide`, `location vide`, `unfurnished`, `non furnished`, `가구 없음`, `가구없음`, `빈집`, `공실`, `옵션 없음`, `옵션없음`, `non meuble`, `nu` (가구 문맥) |
| **unknown** | 위 키워드 어디에도 매칭 안 됨, 또는 본문에 가구 언급 전무 |

### 우선순위 (충돌 시)

1. **명시 부정 (`non meublé`, `vide`, `가구 없음`) > 명시 긍정 (`meublé`, `furnished`, `가구 포함`)**
   - `non meublé` 같은 부정 표현이 단독 `meublé` 매칭을 가리지 않도록, **부정 패턴을 먼저 체크** 후 긍정 패턴 평가.
2. **`bail meublé` (장기임대 메블레 계약) ≠ `meublé`** 라는 일반 단어가 충돌하면, `bail vide` / `location vide` 가 명시되어 있으면 `non` 우선.
3. 동일 listing에 모순된 표기 (예: 본문에 `meublé`와 `vide` 둘 다) → `unknown` (사람이 확인 필요).
4. 사진 캡션이나 가구 이름(`canapé`, `lit double`, `소파 침대` 등)만 있고 `meublé` 단어 없으면 → `unknown` (가구 사진은 모델하우스일 수 있어 추정 금지).
5. **세미 메블레 / `semi-meublé` / 부분 가구** → `meuble` 로 분류 (사용자 입장에서 "옵션 있음"으로 카운트).

### 한국어/프랑스어 혼용 예시

```
"파리 14구 T2 35m² 1300€/월 meublé 장기임대"          → meuble="meuble"
"3 pièces 65m² location vide 1750€"                    → meuble="non"
"방2 가구 포함 1500€/월 9구"                            → meuble="meuble"
"40m² 빈집 1400€/월 11구"                               → meuble="non"
"T2 38m² 1200€ — 거실에 소파 있음"                      → meuble="unknown" (소파만으로는 풀옵션 판정 X)
"Bail meublé 12 mois Studio 28m²"                       → reject (T1+면적); meuble 추출 생략
"Appartement non meublé, semi-meublé négociable"        → meuble="unknown" (모순)
"옵션 없음, 가전 없음, 직접 구비"                        → meuble="non"
```

### 다른 축과의 관계

- `term` 축의 `bail meublé` / `bail vide` 키워드는 **장기임대 판정 신호**일 뿐, `meuble` 축 추출과는 독립적으로 평가 (단, 부수적으로 신호로 활용 가능).
- `area_m2` 축에서 `메블레 1P` (= studio meublé) 가 reject 사유인 것과 별개로, T2+ 메블레는 정상 통과 후 `meuble="meuble"` 로 기록.
- reject 된 listing 은 listings.jsonl 에 들어가지 않으므로 `meuble` 추출도 생략. pass / ambiguous listing 에 대해서만 채운다.

## 판정 알고리즘

1. 우선 "비매물" 체크: `title`이 "구합니다/구해요/찾고있/머물 곳" 등 임차 희망 글이면 즉시 reject (`not_a_listing`).
   - 단, title에 "임대 합니다/임대합니다/장기임대/단기임대/매매합니다/내놓/세놓/하실분 찾/입주자 찾/매수자 찾" 들어있으면 owner posting → 비매물 false alarm 회피
2. `deal_type` 결정:
   - 매매 키워드 있음 → reject (즉시)
   - 임대 키워드 있음 → rent
   - 모호 → unknown (ambiguous로 진행)
3. `term` 결정 (long / short / flex / unknown) — **term 자체로는 reject 안 함** (1주 미만 관광 제외).
4. 가격 → **월세 환산** 후 ≤1800 평가 (단위별 환산은 “가격 단위 판별 가이드”).
5. **기간·입주**은 “## 기간 판정 (장기/단기 2-트랙)”의 절차로 장기/단기 적격성 판정.
6. 7축 종합 → reject 1개라도 → reject. 0 reject + ambiguous 1개 이상 → ambiguous. 모두 pass → pass.
   - 단, 기간 축은 “두 track 중 하나라도 pass면 그 축 pass” (장기 fail이어도 단기 pass면 통과).

## 위치 정밀 추출 (location_text → 지오코딩 입력) 가이드

지도 핀 정확도를 위해 본문 + 제목에서 가장 정밀한 위치 정보를 추출.

**핵심 정책: 메트로역 정보가 가장 신뢰도 높음** — 같은 거리/구 매물도 메트로역 단위로 분산되어 핀 클러스터링 회피. `idf_stations.json`(약 800개 IDF metro/RER/tram 역 OSM 데이터)이 1순위 lookup.

### geocode.py 우선순위 (6단계)

1. **metro-osm**: `metro_lookup.find_station_in_text()` — 800+ IDF 역 데이터에서 본문/제목 텍스트 패턴 매칭. 가장 정확 (역 단위 ~300m 정밀도)
2. **metro (legacy)**: 한국어 음역 alias 포함 정적 lookup (~60개)
3. **suburb**: 92/93/94 inner 도시 (블로뉴, 방브, Vincennes 등) + Korean alias
4. **nominatim**: OSM 실시간 거리명+우편번호 검색 (1 req/sec rate-limited)
5. **arrondissement**: 75XXX 또는 "Paris NE" → 구 중심점 (낮은 정밀도)
6. **fallback**: Paris 중심점 (마지막 수단)

### 본문에서 location_text 만들 때 (LLM이 출력하는 필드)

LLM은 다음 우선순위로 `location_text`를 채워야 함:

#### francezone (bbs_2 / bbs_3)

대부분 vivefrance.com 류 중개사가 정형화된 형식 사용. 추출 우선순위:

```
[교통] M7 Crimée역, 도보시간 3분           → location_text="M7 Crimée"      (1순위)
[교통] RER B Port-Royal역                  → location_text="RER B Port-Royal"
[위치] quai saint michel 75005             → location_text="quai saint michel 75005"
[위치] avenue Jean Jaurès  75019 paris    → location_text="avenue Jean Jaurès 75019"
제목 "[파리 5구]" + 본문 메트로 없음        → location_text="5구 75005"      (fallback)
```

핵심: `[교통]` 섹션의 메트로역명을 1순위로 추출. 거리명+우편번호는 2순위. 구 정보는 마지막.

#### pap.fr

pap.fr 카드의 `location_text` 필드(`Paris 18E (75018)`)는 우편번호 단위. 본문 description 안에 메트로 mention 있을 수 있으니 함께 보내면 metro-osm으로 업그레이드:

```
location_text="Paris 18E (75018)"
description="...à deux minutes du métro porte de Clichy..."
→ classify가 location_text="Porte de Clichy, 75018"으로 보강 가능
```

### 매칭 패턴 (`metro_lookup.py`)

다음 텍스트 패턴들을 순서대로 시도:
1. `<X>역` (Korean suffix) — `M7 Crimée역` → `Crimée`
2. `(M|Métro|metro|ligne) [<n>] <Stationname>` — `M4 Alésia` / `métro porte de Clichy`
3. `RER <line> <Stationname>` — `RER B Port-Royal`
4. `T<n> <Stationname>` (tram) — `T3a Porte de Vincennes`
5. `(Place|Square|Sq.|Pl.) <Name>` — `Place Monge`
6. 마지막 수단: 본문 전체에서 capital-leading 단어 그룹들 (`Trocadéro-Boissière`, `Champs-Elysées` 등)을 추출해서 dict 매칭

매칭 시 다이아크리틱 정규화 (`Alésia` ↔ `alesia`), 하이픈/공백 다른 변형, 부분 일치 (전체 → 끝부터/앞부터 단어 drop) 모두 시도.

### 일반 원칙

- **메트로역 1순위**: 같은 구도 역 단위로 분산 (구 centroid는 같은 점에 다 묶임)
- 거리명+우편번호 2순위: 거리 단위 정확
- 구/우편번호: 마지막 수단 (정밀도 낮음, 클러스터링 발생)
- fallback Paris 중심점은 거의 안 나오게: 분류기/지오코더가 본문을 잘 읽으면 1-2건만 발생

## reject 시 동작

- listings.jsonl 추가 X
- Discord 알림 X
- state seen_post_ids에는 추가 (다음 cron에서 재처리 안 되도록)

## ambiguous 시 동작

- listings.jsonl 추가 (verdict="ambiguous", ambiguous_axes 기록)
- Discord 알림 ⚠️로 발송
- 지도 핀 노란색

## pass 시 동작

- listings.jsonl 추가 (verdict="pass")
- Discord 알림 ✅로 발송
- 지도 핀 녹색
