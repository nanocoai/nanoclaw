---
name: COABAZ automation project
description: Building OTM test sequences for כחב"ז (CEU_COAH) device — pipeline status, bugs fixed, next steps
type: project
originSessionId: 8eb3d5d1-6fa0-46bd-8a2e-62f1040b9b23
---

פרויקט: המרת 90 רצפי COABAZ (כחב"ז/CEU_COAH) מ-TPG legacy → OTM DB.
אותה מערכת MASHA ATE, UUT שונה (לוח CEU במקום לוח YAHAB).

**Why:** אוטומציה מלאה של pipeline כחב"ז, ברמת איכות YAHAB V4.

## נתיבים מרכזיים

| מה | נתיב |
|----|------|
| TXT מקור | `MASHA\masha tpg\CEU_COAH\TXT_OUTPUT\*.txt` |
| TXT מאוחד | `MASHA\COABAZ\רצפים כחב"ז.txt` |
| Step plans | `MASHA\COABAZ\step_plans\*.md` |
| DB כחב"ז | `nanoclaw\groups\masha\resources\COABAZ_DB\COAH_BAZ_TestsDefinitions.data` |
| DB password | `Y8&j3*Eq7!OsN#` |

## Git

- Repo: `MASHA_dev_tools` → https://github.com/shiramlm/MASHA_dev_tools
- Branch כחב"ז: `coabaz` (נוצר 2026-05-09)
- סקילים: `nanoclaw/.claude/skills/masha-*` (commit `20ed0fd`)
- קוד: `MASHA/COABAZ/` (commit `b919ef3` על `batch-3.5`, ממשיך על `coabaz`)

## Pipeline

```
build_step_plans.py  →  step_plans/*.md  →  coabaz_to_db.py  →  DB
```

## Phase 1 — רצפים ללא TSTCEU_COM (הושלמו 2026-05-09)

רצפים: 8, 21, 23, 24, 25, 80, 81, 82, 84 — כולם עברו audit ✅

**באגים שתוקנו:**
1. `build_step_plans.py` `clean_text()` — לא הסיר `*` border decorations (e.g. `* CR2 *` → `CR2`)
2. `coabaz_to_db.py` `VarDescription` — Access/Jet ממיר `''` ל-NULL דרך ADODB → פתרון: `' '` (space)

## Phase 2 — כל הרצפים (pending)

ממתין ל:
- DB מהמחשב המטרה + הערות שגיאות מסטודנטית
- תיקון כללים לפי השגיאות
- `build_step_plans.py --all` + `coabaz_to_db.py --all --force`

## כללים שונים מ-YAHAB

- Device: `Dmm2w` (לא `DMM-1`)
- `R-2-WIRE` → `R-2-WIRES`, `AUTO` → `AUTO-DMM`
- Pin format: `Jx-yy` (לא `Jx/yy`)
- VarPrecision: מחושב מספרות עשרוניות של bounds (לא קבוע 2)
- TSTCEU_COM: 3 rows כמו TST_YAHAB אבל CeuResult במקום YahabResult

**How to apply:** כשמשתמשת מביאה DB או שגיאות — קודם תקן כללים, אז `--all --force`.
