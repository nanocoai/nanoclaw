---
name: MASHA agent project
description: User is building Claude agents to audit and fix 142 MASHA test sequences. Context lives in groups/masha/MASHA_PROJECT.md
type: project
originSessionId: 84755ca3-2cdd-4e2d-8b27-62374663e851
---
User is running a reverse-engineering project (MASHA) converting 1980s military test sequences to OTM system.
Full context doc: `C:/Users/User/Documents/GitHub/nanoclaw/groups/masha/MASHA_PROJECT.md`

**Why:** 142 tests have systematic quality bugs (wrong captions, missing units, wrong tolerances) — want agents to audit+fix the pipeline code, not tests one-by-one.

**How to apply:** When user asks about MASHA agents or test quality work, read MASHA_PROJECT.md first. The NanoClaw bot for MASHA is called "Asi" (Discord, dc2: prefix, groups/masha/ folder). Trigger: @Asi.

Key decisions made:
- TXT קובע הכל. סדר: TXT → JSON → DB. TXT הוא מקור האמת.
- חובה לעצור ב-test_end בפרסור TXT — אחריו זבל מהמרת בינארי
- Access DB → SQLite mirror for read/audit (resources/reference_db.sqlite)
- Write back via create_otm_test.py (automation_v0)
- Agent architecture: Auditor → Pattern Analyzer → Fixer → Validator
- Auditor script: groups/masha/resources/auditor.py — עובד, פיילוט אושר
- MASHA project dir mounted into Asi's container at /workspace/extra/masha
- seq_status.csv: מעקב סטטוס ידני — Locked/Verified = נבדק ידנית (95% נכון)
