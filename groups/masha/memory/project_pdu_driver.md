---
name: PDU Driver Development Status
description: Status of BynetPDU_Driver development for BYNET BTS97216971A on ELISRA target machine
type: project
originSessionId: b1663b60-3e82-490c-825b-157bffc693f2
---
PDU Telnet driver + WinForms tester deployed to ELISRA target machine (branch: yahab_integration_v2 in ElISRA_MASHA_YAHAB repo).

**Why:** BYNET PDU BTS97216971A (28-outlet) needs to be controlled via Telnet for MASHA test automation.

**How to apply:** When continuing PDU work, check the open issues below first.

## What's done
- BynetPduDriver.cs: Telnet driver, prompt is `[pdu]`, response format `[pdu] ON` / `[pdu] OFF`
- BynetPDU_Tester: WinForms app with Scan All / ON / OFF / RST per outlet
- Fixed: SDK-style .csproj, `Any CPU` spacing in .sln, Connect() skips credentials if no login prompt
- Fixed: ParseOutletState uses EndsWith(" ON") / EndsWith(" OFF")
- IP on target machine: 192.168.0.254 (PDU is on 192.168.0.x subnet, NOT 192.168.1.x)

## Open issues
1. **SCAN turns all outlets to ON physically** — suspected "Power Restore Mode" on PDU: each of 28 Telnet connections may trigger outlet reset. Need to check PDU web interface (http://192.168.0.254) for "Power Restore" / "Startup State" setting → should be "Last State" not "On". Fix: batch all reads in a single Telnet session.
2. **Outlet 26 not responding via web interface** — page refreshes but no effect. PDU and target machine shut down before investigation. Check if other outlets respond in web UI, or if outlet 26 is physically locked/disabled.
3. **SCAN always shows all ON** — may still be a parser issue or the power restore mode above.

## Network
- PDU: 192.168.0.254 port 23 (Telnet), no login prompt (auto-login)
- All instruments: 192.168.0.x subnet
- Target machine has additional IP on 192.168.0.x to reach PDU

## Files
- Driver: ElISRA_MASHA_YAHAB/pdu/BynetPduDriver.cs
- Tester: ElISRA_MASHA_YAHAB/pdu/BynetPDU_Tester/MainForm.cs
- Config: ElISRA_MASHA_YAHAB/MASHA_Wrapper/Config.ini → [PDU] section
