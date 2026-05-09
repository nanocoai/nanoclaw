---
name: masha-audit
description: Audit YAHAB or COABAZ test sequences by comparing DB output against TXT source. Reports field-level discrepancies (wrong tolerance, missing unit, bad caption, wrong criteria). Use to verify existing DB entries or validate pipeline output after a rebuild.
---

# /masha-audit — DB vs TXT Audit

Dumps a test from the DB, reads the TXT source, and reports every discrepancy.
The DB is the ground truth for verified tests. TXT is the ground truth for content.

## Paths

| What | Path |
|------|------|
| YAHAB reference DB | `C:\Users\User\Documents\GitHub\nanoclaw\groups\masha\recource_yahab\db\YAHAB_TestsDefinitions.data` |
| YAHAB working DB | `C:\Users\User\Documents\GitHub\MASHA\Orion\OTM\DB\UUTs\YAHAB\YAHAB_TestsDefinitions.data` |
| COABAZ DB | `C:\Users\User\Documents\GitHub\nanoclaw\groups\masha\resources\COABAZ_DB\COAH_BAZ_TestsDefinitions.data` |
| YAHAB TXT | `C:\Users\User\Documents\GitHub\MASHA\TXT_OUTPUT\<N>.txt` |
| COABAZ TXT | `C:\Users\User\Documents\GitHub\MASHA\masha tpg\CEU_COAH\TXT_OUTPUT\<N>.txt` |
| YAHAB step plans | `C:\Users\User\Documents\GitHub\MASHA\automation\automation_v4\all_step_plans.md` |
| COABAZ step plans | `C:\Users\User\Documents\GitHub\MASHA\COABAZ\step_plans\<N>.md` |
| DB password | `Y8&j3*Eq7!OsN#` |
| PS32 | `C:\Windows\SysWOW64\WindowsPowerShell\v1.0\powershell.exe` |

## Step 1 — Dump DB

Use 32-bit PowerShell to dump the test. Query pattern:

```powershell
# Get steps + outputs + inputs for test N
SELECT s.Pos, s.FunctionName, s.StepName, s.DiagnosticRemark,
       s.AddCaption2Report, s.ManualFailureAction, s.StepPhase, s.Condition,
       o.Name, o.DisplayName, o.VarTypeName, o.IsReturnValue,
       o.VarMins, o.VarMaxs, o.VarComparisonTypes, o.VarUnit, o.VarPrecision,
       o.Record, o.CompactReport, o.VarVisible, o.MinPhrase, o.MaxPhrase,
       o.MinPhraseCompilationFileName, o.VarDescription
FROM TestSteps s
LEFT JOIN StepVariablesOut o ON o.StepId = s.TestStepsId
WHERE s.TestId = <TestListId>
ORDER BY s.Pos, o.ArgOutVarId
```

Note: TestNumber is a text field in Access. Query TestList by TestNumber=`'<N>'` (string).

## Step 2 — Read TXT source

Read `TXT_OUTPUT\<N>.txt`. Stop at `test_end`.
Parse each functional line: function|param1|param2|param3|param4|result

## Step 3 — Compare

For each step in the DB, find its corresponding TXT line. Check:

### OTM_RULES violations (critical — cause crashes):
- `StepPhase` is NULL? If not → ERROR
- `Condition` is NULL? If not → ERROR
- `ManualFailureAction = 63`? If not → ERROR
- `MinPhrase / MaxPhrase = "NA"`? If NULL → ERROR
- `MinPhraseCompilationFileName = "NA"`? If NULL → ERROR
- `VarDescription = ""`? If NULL → ERROR
- `VariableBase = 10`? If not → ERROR
- Any non-ASCII in `DiagnosticRemark` or `StepName`? → ERROR

### DMM_READ:
- `AddCaption2Report = 1` on the TestSteps row? If 0 and remark exists → WARNING
- Output `VarMins/VarMaxs` match tolerance from TXT result column (via tolerance_mapping.json)? If not → ERROR
- `VarUnit` correct for tolerance type? (V=1, OHM=11, etc.) If wrong → ERROR
- `VarPrecision = 2`? If not → WARNING

### TST_YAHAB:
- Exactly 3 output rows? (RetVal, RetVal/Status, RetVal/Value) If not → ERROR
- Row 0: type=YahabResult, rec=0, vis=0? If not → ERROR
- Row 1: type=String, criteria from TXT result column? If criteria wrong → ERROR
- Hex criteria (`$XX`) on Row 1 (String)? If on Row 2 (Double) → CRASH ERROR
- Row 2: hidden for WRITE, visible for READ?

### COABAZ additions (if auditing COABAZ):
- Device name = `Dmm2w` (not `DMM-1`)? If wrong → ERROR
- TSTCEU_COM: 3-row CeuResult pattern?
- Pin format: `Jx-yy` (not `Jx/yy` or `Jx/yyGND`)?
- DMM_SETUP mode: `R-2-WIRES` (not `R-2-WIRE`)?
- VarPrecision derived from tolerance bounds?

## Step 4 — Report

Format as a table:

```
Test <N>: <DisplayName>
Steps in DB: X | Steps expected from TXT: Y

ERRORS (block insertion):
  [step 5] DMM_READ: VarMins=NULL, expected=-5 (SHORT tolerance)
  [step 8] TST_YAHAB: hex '$80' on Row 2 (Double) — must be on Row 1 (String)

WARNINGS (non-blocking):
  [step 3] DMM_READ: AddCaption2Report=0, expected=1

OK:
  StepPhase=NULL ✓ | Condition=NULL ✓ | mfa=63 ✓
  MinPhrase=NA ✓ | TST_YAHAB 3-row ✓
```

## Scope

**YAHAB tests to audit (reference DB):** 18–89, 91–109, 111–142 (skip 1–17, 90, 110)
**COABAZ tests to audit:** 80, 81, 82, 84, 8, 21, 23, 24, 25 (Phase 1 — already inserted)

## Iteration workflow

1. Run `/masha-audit yahab <N>` — get error list
2. For each ERROR: find the failing rule in `agents/*.md`, verify rule is correct against the reference DB
3. If rule is wrong → fix the agent rule file
4. If DB entry is wrong → run `/masha-yahab-pipeline <N>` to rebuild
5. Re-audit to confirm errors are gone
