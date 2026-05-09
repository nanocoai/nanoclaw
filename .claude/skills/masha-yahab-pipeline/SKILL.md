---
name: masha-yahab-pipeline
description: Run the YAHAB OTM pipeline for one or more test sequences. Parses TXT source, applies all domain rules (messages, calculate, yahab, dmm, matrix, digital, analog, scope, serial, flowcontrol, dataflow, validator), and inserts correct entries into the YAHAB DB. Use when building or rebuilding YAHAB test definitions.
---

# /masha-yahab-pipeline — YAHAB Pipeline Runner

## Paths

| What | Path |
|------|------|
| Project root | `C:\Users\User\Documents\GitHub\MASHA` |
| TXT source | `TXT_OUTPUT\<N>.txt` |
| Step plans (source of truth) | `automation\automation_v4\all_step_plans.md` |
| Pipeline scripts | `automation\automation_v4\` |
| Agent rules | `automation\automation_v4\agents\` |
| Working DB | `Orion\OTM\DB\UUTs\YAHAB\YAHAB_TestsDefinitions.data` |
| Reference DB | `C:\Users\User\Documents\GitHub\nanoclaw\groups\masha\recource_yahab\db\YAHAB_TestsDefinitions.data` |
| DB password | `Y8&j3*Eq7!OsN#` |
| SQLite mirror | `C:\Users\User\Documents\GitHub\nanoclaw\groups\masha\resources\reference_db.sqlite` |
| seq_status | `C:\Users\User\Documents\GitHub\nanoclaw\groups\masha\resources\seq_status.csv` |
| PS32 | `C:\Windows\SysWOW64\WindowsPowerShell\v1.0\powershell.exe` |

## Before Running — Status Check

Read `seq_status.csv`. Find the test number(s).

**NEVER run `--force` on:** Locked, Verified, 95%, In Progress.
**SAFE to build:** empty status or ≤50%. Confirm with user before each change.

## Pipeline Steps (run in order)

### Step 1 — Read source

```bash
# Find test section in all_step_plans.md (NEVER read the full 729KB file)
grep -n "## Test <N>" automation/automation_v4/all_step_plans.md
# Then: Read with offset+limit for only that test's section
```

Also read the raw TXT source:
```
TXT_OUTPUT\<N>.txt
```
Stop at `test_end` — everything after is binary garbage.

### Step 2 — Generate raw CSV

```bash
cd C:\Users\User\Documents\GitHub\MASHA
python automation/automation_v4/plan_to_csv.py <N>
```

Output goes to `automation/automation_v4/stage3_csv/output/<N>.csv`.
This is a RAW extract — it will have errors. Do NOT stop here.

### Step 3 — Apply agent fixes (in order)

Read each agent rule file and apply its fixes to the CSV. Apply in this exact order:

1. `agents/messages.md` — strip Hebrew, clean separators, fix remarks
2. `agents/calculate.md` — SetValue/Math/LocalVars, comp_param absorption
3. `agents/yahab.md` — TST_YAHAB 3-row pattern, hex criteria, read/write
4. `agents/dmm.md` — DMM_READ output, tolerance lookup, store_mes absorption
5. `agents/matrix.md` — pin name cleaning, Config.ini verification
6. `agents/digital.md` — RD_DIGITAL String output, WR_DIGITAL param order
7. `agents/analog.md` — AO/servo params
8. `agents/scope.md` — oscilloscope outputs
9. `agents/serial.md` — firmware burn
10. `agents/flowcontrol.md` — If/GoTo/While
11. `agents/dataflow.md` — variable chain verification
12. `agents/validator.md` — final gate (blocks on any error)

**Read `agents/OTM_RULES.md` FIRST** — it contains global DB field rules that all agents must respect.

For each agent, report what was changed.

### Step 4 — Validate

```bash
python automation/automation_v4/validate_csv.py <N>
```

Must pass ALL checks. If fails → go back to Step 3, fix the specific rule, re-apply.

### Step 5 — Insert to DB

Only if validate passes:

```bash
python automation/automation_v4/csv_to_db.py --db Orion/OTM/DB/UUTs/YAHAB/YAHAB_TestsDefinitions.data --force <N>
```

CSV goes 1:1 to DB. No transformations at this stage.

### Step 6 — Verify

```bash
# Dump the test to check output
python automation/automation_v4/dump_db_csv.py <N>
```

Compare key fields against the reference DB if unsure.

---

## Critical Rules (from OTM_RULES.md)

### TestSteps must have:
- `StepPhase = NULL` (not 0)
- `Condition = NULL` (not "")
- `ManualFailureAction = 63`
- `EnableExclude = 1`
- `ConstructorInstantSavedInVariableType = 6`, `ConstructorInstantSavedInVariableId = 0`
- `ClassVariableType = 6`, `ClassVariableId = 0`
- `DiagnosticRemark` — NO Hebrew, NO `()`, NO `"`, NO em-dash/en-dash, NO separators
- `AddCaption2Report = 1` on every DMM_READ step that has a remark

### StepVariablesOut must NEVER be NULL:
`MinPhrase`, `MaxPhrase`, `MinPhraseCompilationFileName`, `MaxPhraseCompilationFileName` → `"NA"`
`VarMinsCriteriaVars`, `VarMaxsCriteriaVars`, `ArgOutVarId`, `LoopCondition`, `RecordOnFailure` → `0`
`VarDescription` → `""` (empty string)
`VariableBase` → `10`
`IsReturnValue` → `0` or `1`

### TST_YAHAB — 3 rows always:
| Row | Name | Type | Hidden/Visible |
|-----|------|------|----------------|
| 0 | `<-- RetVal` | YahabResult | hidden (rec=0, cpt=0, vis=0) |
| 1 | `<-- RetVal/Status` | String | visible, criteria here (OK or hex) |
| 2 | `<-- RetVal/Value` | Double | hidden for WRITE, visible for READ |

**Hex criteria ($80, $0000) go on Row 1 (String), NEVER on Row 2 (Double) — causes crash.**

### DMM_READ output:
- `Name = "<-- RetVal"`, `VarTypeName = "Double"`, `IsReturnValue = 1`
- `VarComparisonTypes = 1`, tolerance from `tolerance_mapping.json`
- `Record = 1`, `CompactReport = 1`, `VarVisible = 1`
- `AddCaption2Report = 1` on the TestSteps row (not StepVariablesOut)

### Absorbed steps (NEVER appear in DB):
- `store_mes` → absorbed into preceding measurement output + LocalVar link
- `comp_param` → absorbed into preceding measurement/math output criteria
- `screen N |NO STOP` → deleted entirely
- `remark` → accumulated into DiagnosticRemark of next step
- `test`, `test_end`, `dummy` → deleted entirely

### Pin name cleaning:
`A-J9/27` → `J9-27` (strip `A-`, replace `/` with `-`, strip trailing `GND`/`(SR`)

### Wait — seconds not milliseconds:
If `intervalSec > 100` → divide by 1000.

---

## Multi-block sequences (`*` prefix)

Sequences like `*57`, `*58`, `*60`, `*50` contain multiple `test | N` blocks.
Import ALL blocks before `test_end`. BLOCK 1 (init) must NOT be skipped.

---

## Reference: DEMO test #900

Ground truth for DB field values. NEVER modify.
```bash
python automation/automation_v4/dump_db_csv.py 900
```

---

## Scope

**Tests 1–17, 90, 110: ignore** (user decision).
**Tests 18–89, 91–109, 111–142**: safe to learn from. Verify seq_status before touching.
