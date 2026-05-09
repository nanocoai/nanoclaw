---
name: MASHA branch map
description: Branch structure of שני repos — ElISRA_MASHA_YAHAB (wrapper) ו-MASHA_dev_tools (automation)
type: project
originSessionId: aec16684-dd59-4693-b3e0-137068197473
---

## Repo 1: ElISRA_MASHA_YAHAB (wrapper/HW)

`c:\Users\User\Documents\GitHub\MASHA\ElISRA_MASHA_YAHAB`

| Branch | מה יש שם |
|--------|----------|
| `main` | Base — OTM DB, "WP is running!" |
| `yahav_integration_WP` | **בדיקות חומרה אמיתיות מול UUT** — מקור עמודת Integration ✅ |
| `yahab_integration_v2` | HEAD/current — matrix `;` separator + PDU→6TL rename |
| `wrapper-coabaz` | COABAZ config — RESET CMNDS, RESOLVER CONFIG |

**Why:** `yahav_integration_WP` = מקור האמת לאינטגרציה HW.

---

## Repo 2: MASHA_dev_tools (automation pipeline)

`C:\Users\User\Documents\GitHub\MASHA` → https://github.com/shiramlm/MASHA_dev_tools

| Branch | מה יש שם |
|--------|----------|
| `main` | base |
| `batch-3.5` | YAHAB + COABAZ pipeline (commit `b919ef3`) |
| `coabaz` | **branch ייעודי כחב"ז** — קוד + סקילים + זיכרון (נוצר 2026-05-09) |

**Why:** `coabaz` branch = כל שינוי לכחב"ז (קוד, agent rules, סקילים) מנוהל יחד.

---

## nanoclaw (skills + memory)

`C:\Users\User\Documents\GitHub\nanoclaw` — branch `main`
- `.claude/skills/masha-*` — סקילים, commit `20ed0fd`
- `groups/masha/memory/` — זיכרון מגובה ב-git (2026-05-09)

**How to apply:** כשמפתחים כחב"ז → branch `coabaz` ב-MASHA_dev_tools. כשמעדכנים סקיל → גם ב-nanoclaw וגם ב-`MASHA/COABAZ/skills/`.
