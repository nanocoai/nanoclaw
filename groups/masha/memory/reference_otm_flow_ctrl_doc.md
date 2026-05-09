---
name: OTM Flow Control Translation Document
description: Location of the documented translation from legacy TPG GOTO/LABEL patterns to OTM IF/ELSE/WHILE, covering tests 106, 90, 69, 58, 60, 110, 78
type: reference
originSessionId: d7132e8a-6a2d-4b3b-b436-8bed41ca6542
---
The full OTM flow control translation guide lives at:

`c:\Users\User\Documents\GitHub\MASHA\docs\OTM_FLOW_CTRL_SEQ_106_90_69_58.md`

## What's documented there

4 patterns with full legacy→OTM pseudocode for each:

| Pattern | Tests | OTM construct |
|---------|-------|---------------|
| Timeout Retry Loop | 58, 60, 69 | WHILE + success flag |
| Bisection/Servo Calibration Loop | 90 (×3 loops), 106 | WHILE + IF/ELSE direction |
| Digital Pulse Retry | 110 (×8) | IF/ELSE one-shot guard |
| Simple IF/ELSE Branch | 78 | IF/ELSE, no loop |

## Key decisions recorded there
- `dec_failur` → **deleted everywhere**, no OTM equivalent needed
- `case pass` and `case MEAS=PAR4|1` → same thing, both become `IF (pass)`
- `case UNCOND` after IF body → disappears (it's the ELSE separator)
- `case MEAS/PAR4` (appears in test 110 line 128) → **NOT translated yet**, unknown semantics, needs TRAIL investigation
- Tests 104, 105, 125, 126, 127, 128 → fully linear, zero flow control work needed

## Test 90 loop breakdown
Three independent sequential loops in test 90:
- Loop A (lines ~61–120): tunes `RG`, threshold 1.5, timeout 200
- Loop B (lines ~230–275): tunes `OFFSET1`, threshold 0.001, timeout 300
- Loop C (lines ~298–355): tunes `ADJUST-1`, averages 5 reads, threshold 0.2, timeout 200
