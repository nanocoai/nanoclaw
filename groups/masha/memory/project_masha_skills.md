---
name: MASHA pipeline skills
description: NanoClaw skills for YAHAB and COABAZ OTM pipeline automation — locations, git status, workflow
type: project
originSessionId: be23fd77-4856-4f76-af0f-ab49d4b8902e
---

4 סקילים עבור פייפליין MASHA/COABAZ.

**Why:** iteration מהיר — audit, בנייה, תיקון agent rules — במקום להריץ סקריפטים ידנית.

## מיקום סקילים

סקילים יושבים ב-`nanoclaw/.claude/skills/` — git-backed, commit `20ed0fd` (2026-05-09).
קלוד Code סורק `.claude/skills/` אוטומטית מתיקיית הפרויקט הפעילה (nanoclaw).

| סקיל | נתיב ב-nanoclaw | שימוש |
|------|----------------|--------|
| `/masha-yahab-pipeline` | `.claude/skills/masha-yahab-pipeline/SKILL.md` | TXT→CSV→agents→validate→DB |
| `/masha-coabaz-pipeline` | `.claude/skills/masha-coabaz-pipeline/SKILL.md` | TXT→step_plan→DB |
| `/masha-audit` | `.claude/skills/masha-audit/SKILL.md` | DB dump vs TXT audit |
| `/masha-pipeline` | `container/skills/masha-pipeline/SKILL.md` | Asi container entrypoint |

גם מועתקים ל-`MASHA/COABAZ/skills/` על branch `coabaz` — כדי שסקיל + קוד מנוהלים ביחד.

## Reference DB (ground truth ליחב)

`nanoclaw\groups\masha\recource_yahab\db\YAHAB_TestsDefinitions.data`
- Tests 1-17, 90, 110: להתעלם
- Tests 18-89, 91-109, 111-142: ללמוד ממנו

## Iteration workflow

`/masha-audit coabaz <N>` → identify errors → fix rule → rebuild → re-audit

**How to apply:** כשמשתמשת מבקשת לעבוד על MASHA/COABAZ, הפעל את הסקיל המתאים.
