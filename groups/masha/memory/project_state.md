# MASHA Project State

## COABAZ_Wrapper stubs
Assi created stub scaffolding in `groups/masha/resources/COABAZ_Wrapper/`:
- ATPFunctions.cs, AnalogOutputFunctions.cs, DigitalFunctions.cs
- DmmFunctions.cs, GalTimingFunctions.cs, MatrixFunctions.cs
- MeasurementFunctions.cs, PowerSupplyFunctions.cs, SerialFunctions.cs
- ServoFunctions.cs, SystemFunctions.cs, UtilityFunctions.cs

All are stubs (`throw new NotImplementedException`). Not yet implemented.

## Shared functions question (open)
MASHA_Wrapper (YAHAB) and COABAZ_Wrapper share overlapping categories:
DMM, Digital, AnalogOutput, Matrix, Measurement, PowerSupply, Serial, Servo, System.
Open question: should shared logic go in a common base library?
Waiting for user decision.

## 90 new sequences (COABAZ)
User wants to add 90 new sequences from כחב"ז system.
TXT source: `resources/COABAZ_TXT_OUTPUT/`
Status: not started yet.
