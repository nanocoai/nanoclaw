---
name: flight-checkin
description: Complete online check-in for a flight on any airline — from a check-in reminder email or a direct user request. Finds the check-in link, completes the flow for all passengers, delivers boarding passes, and falls back to notifying the user with the confirmation number if anything blocks. Use when the user asks to check in for a flight, or when a scheduled task detects a check-in reminder email.
allowed-tools: Bash(agent-browser:*), Bash(curl:*), Bash(timeout:*)
---

# Flight Check-in

Completes online check-in for a booked flight via `agent-browser`, on any airline.

## Passenger config (required)

Passenger details live in `/workspace/agent/flight-checkin.json`:

```json
{
  "lastNames": ["Smith", "Jones"],
  "boardingPassEmails": ["person@example.com"]
}
```

- `lastNames` — booking last names to try, in order (bookings may be under different travelers).
- `boardingPassEmails` — where to email boarding passes when the airline offers it.

If the file doesn't exist, ask the user for these once, save the file, and continue.

## Safety rules (mandatory — a hung browser can kill this whole session)

1. Prefix **every** `agent-browser` invocation with `timeout 120`.
2. Abandon the check-in attempt entirely after **~10 minutes** total. Fall back to notifying (below). Never retry in a loop.
3. Every `curl` gets `--max-time 30`.
4. When triggered by an email watcher, **mark the email processed BEFORE attempting check-in** (see Dedupe below) — otherwise a failed attempt re-triggers the watcher forever.
5. Keep existing seats. **Decline all paid upsells** — bags, seat upgrades, priority boarding, insurance. If the airline *requires* a payment to complete check-in (e.g. a mandatory bag fee), stop and ask the user — never enter payment details autonomously.

## Dedupe (when triggered by an email watcher)

The watcher task passes `emailId` in its script data. FIRST, before opening a browser:

1. Append the `emailId` to `/workspace/agent/.checkin_processed.json` (create as a JSON array if missing).
2. Mark the email read:
   ```bash
   curl --max-time 30 -s -X POST "https://gmail.googleapis.com/gmail/v1/users/me/messages/EMAIL_ID/modify" \
     -H "Content-Type: application/json" -d '{"removeLabelIds":["UNREAD"]}'
   ```
3. If the email turns out not to be a real airline check-in reminder (hotel, marketing), stop silently — it is already marked processed.

## Check-in flow

1. Get the confirmation number, airline, flight, and check-in link — from the reminder email body, or by asking the user / checking workspace trip notes for a direct request.
2. Open the check-in link from the email if present; otherwise the airline's standard online check-in page.
3. Enter the confirmation number + each configured last name until the booking is found.
4. Select all passengers, complete every step, keep seats, decline upsells.
5. On the boarding-pass page: email passes to the configured addresses. If email isn't offered, screenshot each boarding pass and send the images to the chat.
6. Message the chat: airline, flight, route, seats, sequence numbers, and where the passes went.

## Fallback (check-in failed, timed out, or blocked)

Send the chat a message with: airline, flight, **confirmation number**, departure time, and the check-in link so a human can finish in under a minute. State plainly what blocked you (e.g. "airline wants a bag fee", "page timed out"). Do not retry.

## Setting up an automated watcher (optional)

To check in automatically whenever a reminder email arrives, schedule an hourly task with `schedule_task` (requires the Gmail MCP tool / gateway to be set up for this group).

- **script**: use the contents of `checkin-watcher.sh` (in this skill's directory) verbatim. It searches Gmail for recent check-in reminder emails, dedupes against `/workspace/agent/.checkin_processed.json`, and is fail-safe: every fetch has a timeout and any error resolves to `wakeAgent: false` — a watcher script must never be able to hang.
- **prompt**:

> A possible airline check-in reminder email was detected. Script data contains emailId, from, subject, and bodyPreview. Invoke the flight-checkin skill and follow it exactly — dedupe step FIRST, safety rules, and fallback if check-in can't complete. If the email is not a real airline check-in reminder, stop silently after the dedupe step.

## Airline notes (grow this as you learn)

- **Avelo**: check-in at `https://checkin.aveloair.com` — confirmation number + last name.
