---
name: masha-coabaz-pipeline
description: Run the COABAZ OTM pipeline for one or more sequences. Builds step plans from TXT source, applies COABAZ domain rules, validates, and inserts into COAH_BAZ_TestsDefinitions.data. Use when building or rebuilding COABAZ (כחב"ז / CEU_COAH) test definitions.
---

# /masha-coabaz-pipeline — COABAZ Pipeline Runner

## Paths

| What | Path |
|------|------|
| Project root | `C:\Users\User\Documents\GitHub\MASHA` |
| TXT source files | `masha tpg\CEU_COAH\TXT_OUTPUT\<N>.txt` |
| Combined TXT | `COABAZ\רצפים כחב''ז.txt` |
| Step plans | `COABAZ\step_plans\<N>.md` |
| Pipeline scripts | `COABAZ\` |
| Agent rules | `COABAZ\agents\` |
| Function map | `COABAZ\coabaz_function_map.json` |
| Tolerance map | `COABAZ\coabaz_tolerance_mapping.json` |
| DB | `C:\Users\User\Documents\GitHub\nanoclaw\groups\masha\resources\COABAZ_DB\COAH_BAZ_TestsDefinitions.data` |
| DB password | `Y8&j3*Eq7!OsN#` |
| PS32 | `C:\Windows\SysWOW64\WindowsPowerShell\v1.0\powershell.exe` |

## Source of Truth Hierarchy

```
TXT source         ← absolute ground truth
COABAZ/agents/     ← domain rules (delta from YAHAB)
step_plans/<N>.md  ← intermediate (generated, can regenerate)
OTM DB             ← final output
```

**Always verify step_plan against TXT before inserting.**

## Pipeline Steps

### Step 1 — Read TXT source

```bash
# Read the TXT for this sequence
type "C:\Users\User\Documents\GitHub\MASHA\masha tpg\CEU_COAH\TXT_OUTPUT\<N>.txt"
```

Stop at `test_end`. Everything after is binary garbage.

Parse the following line types:
- Keep: `ConMat`, `DisConMat`, `DmmSetUp`, `DmmRead`, `RdDigital`, `WrDigital`, `AoVdcSet`, `PsVoltSet`, `PsCrntSet`, `PsRead`, `ConAoDc`, `DconAoDc`, `TSTCEU_COM`, `ServoMux`, `ServoGain`, `Servo_cal`, `BodeGal`, `InitGal`, `SpecInit`, `TcRead`, `TcSetUp`, `RS422_TXD`, `ConPsHp`, `ConDo_10`, `DisConRo`, `SimShaft`, `Init_sl`, `Reset`, `Reset_comm`, `idr`, `idrClrFlg`, `delayDrv`, `Con`, `DisCon`
- Absorb: `StoreMes` (into preceding measurement), `CompParam` (into preceding step output)
- Skip entirely: `remark`, `test`, `test_end`, `dummy`, `tst_loop`, `case`, `label`, `screen`, `set_attr`, `chng_tps`, `ai_start`, `select`, `select_rd`, `show_param`, `calculine`, `tst`, `DUMY`, `DUMMY`, `ATP`

### Step 2 — Rebuild step plan (if needed)

```bash
cd C:\Users\User\Documents\GitHub\MASHA
python COABAZ/build_step_plans.py <N>
```

This regenerates `COABAZ/step_plans/<N>.md`. Always rebuild from TXT to ensure freshness.

### Step 3 — Verify step plan against TXT

Read `COABAZ/step_plans/<N>.md` and compare to TXT:
- Every kept function from TXT must appear as a step
- No skipped function may appear as a step
- StoreMes/CompParam must be absorbed, not separate steps
- Pin names must be cleaned (see Pin Format below)
- Function names must be OTM names (ConMat → CON_MAT, DmmRead → DMM_READ, etc.)

Fix any discrepancies directly in the step plan.

### Step 4 — Apply COABAZ domain rules

Read `COABAZ/agents/rules.md` (delta from YAHAB) and `COABAZ/agents/functions.md`, then apply:

**DMM rules:**
- Device name: `Dmm2w` (not `DMM-1`)
- Tolerance: look up in `coabaz_tolerance_mapping.json`
- VarPrecision: `max(decimal_places(lower), decimal_places(upper))`, minimum 2
- `AddCaption2Report = 1` on every DMM_READ step that has a DiagnosticRemark

**Matrix rules (COABAZ pin format):**
- No `A-` prefix to strip (already absent in COABAZ TXT)
- `Jx/yyGND` → `Jx-yy` (strip `/` and GND suffix)
- `Jx/yy` → `Jx-yy` (replace `/` with `-`)
- Node names (`BOREG_GND`, `RET_5V_GP`, `P24_H`, `+5V_GP1`) → keep as-is

**DMM_SETUP normalization:**
- `R-2-WIRE` → `R-2-WIRES`
- `R-4-WIRE` → `R-4-WIRES`
- `AUTO` (range) → `AUTO-DMM`

**TSTCEU_COM:**
- 3-row output: CeuResult (hidden), Status (String), Value (Double) — same pattern as TST_YAHAB
- Op field: translate Hebrew descriptions to English (see table in `COABAZ/agents/rules.md`)
- Return: READ_BYTE/READ_AD/READ_COUNTERS_x/SEND_FAULTS → has output criteria; writes/init/reset → no output needed

**Function name mapping (TXT camelCase → OTM UPPERCASE):**
Use `COABAZ/coabaz_function_map.json`. Key mappings:
`ConMat→CON_MAT`, `DisConMat→DISCON_MAT`, `DmmRead→DMM_READ`, `DmmSetUp→DMM_SETUP`,
`RdDigital→RD_DIGITAL`, `WrDigital→WR_DIGITAL`, `AoVdcSet→AO_SET`, `PsVoltSet→PS_V_SET`,
`PsCrntSet→PS_I_SET`, `PsRead→PS_READ`, `ConAoDc→CON_AO_DC`, `DconAoDc→DCON_AO_DC`,
`ServoMux→SERVO_MUX`, `ServoGain→SERVO_GAIN`, `Servo_cal→SERVO_CAL`, `BodeGal→BODE_GAL`,
`InitGal→INIT_GAL`, `SpecInit→SPEC_INIT`, `TcRead→TC_READ`, `TcSetUp→TC_SETUP`,
`RS422_TXD→RS422_TXD`, `ConPsHp→CON_PS_HP`, `ConDo_10→CON_DO_10`, `DisConRo→DISCON_RO`,
`SimShaft→SIM_SHAFT`, `Init_sl→INIT_SLOOP`, `Reset→RESET`, `Reset_comm→RESET_COMM`,
`delayDrv→Wait`, `Con→CON`, `DisCon→DISCON`

**All other YAHAB OTM_RULES also apply** (StepPhase=NULL, Condition=NULL, mfa=63, etc.)

### Step 5 — Insert to DB

```bash
python COABAZ/coabaz_to_db.py <N> --dry-run
# Review output, then:
python COABAZ/coabaz_to_db.py <N> --force
```

### Step 6 — Verify insertion

Dump the inserted test from DB and verify key fields:
- Step count matches step plan
- DMM_READ outputs have AddCaption2Report=1, tolerance correct, unit correct
- TST_YAHAB / TSTCEU_COM have 3-row pattern
- No NULL in phrase fields

---

## TSTCEU_COM Hebrew → English Op Translation

| TXT (Hebrew) | op value |
|---|---|
| `DM קרא בית` | `READ_BYTE` |
| `DM כתב בית` | `WRITE_BYTE` |
| `DM קרא בלק` | `READ_BLOCK` |
| `DM כתב בלק` | `WRITE_BLOCK` |
| `1 A/D דגום` | `READ_AD` |
| `C0..CA D/A כתב` | `WRITE_DA_C0..CA` |
| `0..3 אתחל מונה` | `INIT_COUNTER_0..3` |
| `0..1 קרא מונים` | `READ_COUNTERS_0..1` |
| `RESET OUTP` | `RESET_OUTPUTS` |
| `WDT הפסק` | `STOP_WDT` |
| `אפס תקלות` | `RESET_FAULTS` |
| `שלח תקלות` | `SEND_FAULTS` |
| `שלח נעלמות` | `SEND_DISAPPEARED` |

---

## Phase 1 target sequences (DMM only, no TSTCEU_COM)

Seqs: 80, 81, 82, 84, 8, 21, 23, 24, 25

Phase 2 sequences require TSTCEU_COM — defer until CeuFunctions.cs wrapper is implemented.

---

## Known bug to fix before running

`AddCaption2Report = 1` is missing from StepVariablesOut on DMM_READ outputs.
Fix is in `coabaz_to_db.py` — the `_insert_out_row` function must set `AddCaption2Report=1`
in the INSERT for DMM_READ outputs. The TestSteps row already has `cap=1`.

Actually — `AddCaption2Report` is a field on **TestSteps**, not StepVariablesOut.
Check `coabaz_to_db.py` line ~436: `$cmd.Parameters.AddWithValue('@cap', [int]{1 if otm_fn in ('DMM_READ', 'TSTCEU_COM') else 0})` — this should already be setting it.
If it's missing for DMM_READ → add 'DMM_READ' to the condition.
