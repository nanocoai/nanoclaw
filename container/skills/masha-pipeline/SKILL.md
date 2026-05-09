---
name: masha-pipeline
description: Run the MASHA OTM pipeline for a test sequence. Use /masha-pipeline yahab <N> or /masha-pipeline coabaz <N>. Reads TXT source, applies domain rules, and inserts into the DB. Supports --dry-run and --audit flags.
---

# /masha-pipeline — MASHA Pipeline (Asi)

Run from `/workspace/extra/masha` in the container.

## Usage

```
/masha-pipeline yahab <N> [--dry-run] [--audit]
/masha-pipeline coabaz <N> [--dry-run] [--audit]
```

## YAHAB

```bash
cd /workspace/extra/masha

# Step 1: Generate CSV
python automation/automation_v4/plan_to_csv.py <N>

# Step 2: Apply fixes (read agents/ rules and fix the CSV manually)
# Agent order: messages → calculate → yahab → dmm → matrix → digital → analog → scope → serial → flowcontrol → dataflow → validator

# Step 3: Validate
python automation/automation_v4/validate_csv.py <N>

# Step 4: Insert
python automation/automation_v4/csv_to_db.py --db Orion/OTM/DB/UUTs/YAHAB/YAHAB_TestsDefinitions.data --force <N>
```

**Before inserting:** check `groups/masha/resources/seq_status.csv` — never touch Locked/Verified/95%/In Progress.

## COABAZ

```bash
cd /workspace/extra/masha

# Step 1: Rebuild step plan
python COABAZ/build_step_plans.py <N>

# Step 2: Verify step plan vs TXT
# Read COABAZ/agents/rules.md + COABAZ/agents/functions.md

# Step 3: Insert (dry-run first)
python COABAZ/coabaz_to_db.py <N> --dry-run
python COABAZ/coabaz_to_db.py <N> --force
```

## --audit flag

Dumps the test from DB and compares against TXT:

```bash
# YAHAB
python automation/automation_v4/dump_db_csv.py <N>
# Compare against TXT_OUTPUT/<N>.txt

# COABAZ
# Use PowerShell (PS32) to query DB, compare against TXT source
```

## Key rules (always apply)

- `StepPhase=NULL`, `Condition=NULL`, `ManualFailureAction=63`
- `MinPhrase/MaxPhrase="NA"` — never NULL
- TST_YAHAB: exactly 3 rows (YahabResult hidden, String criteria, Double value)
- TSTCEU_COM: same 3-row pattern with CeuResult
- Hex criteria (`$80`, `$0000`) → Row 1 String type ONLY, never Row 2 Double
- `store_mes` / `comp_param` are NEVER separate steps — always absorbed
- `AddCaption2Report=1` on DMM_READ steps with DiagnosticRemark

## Rule files

```
/workspace/extra/masha/automation/automation_v4/agents/OTM_RULES.md   ← global
/workspace/extra/masha/automation/automation_v4/agents/dmm.md
/workspace/extra/masha/automation/automation_v4/agents/yahab.md
/workspace/extra/masha/automation/automation_v4/agents/matrix.md
/workspace/extra/masha/automation/automation_v4/agents/digital.md
/workspace/extra/masha/automation/automation_v4/agents/calculate.md
/workspace/extra/masha/automation/automation_v4/agents/messages.md
/workspace/extra/masha/COABAZ/agents/rules.md                         ← COABAZ delta
/workspace/extra/masha/COABAZ/agents/functions.md
```
