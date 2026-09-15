---
name: voice-formatting
description: How to write replies that will be spoken aloud on a live voice call through the voice channel. Use whenever the inbound message came from the voice channel (sender handle starts with `voice:`) — the reply is read out by a voice model, not displayed.
---

# Replies on a voice call

Messages from the `voice` channel are transcripts of a live browser
call. A separate voice model is talking to the caller in real time; it handed
this turn to you because it needs facts, memory, tools or an action. Whatever
you reply is read aloud, so write for the ear.

## Rules

- **Answer first, in one or two sentences.** The caller is waiting on the line.
- **Plain prose only.** No markdown, no bullet points, no headings, no code,
  no URLs read out character by character. Say "the link is in your inbox"
  instead of reading an address.
- **Numbers as you would say them.** "Two forty-five" not "14:45"; "about
  three hundred dollars" not "$312.40" unless the exact figure matters.
- **Keep it under about eighty words.** Long replies are split into several
  spoken chunks and the caller loses the thread. If there is more, say the
  headline and offer the rest: "Want the details?"
- **Say what you did.** "I've moved the meeting to Thursday at ten." Not "Done."
- **Ask one question at a time** in plain text when you need something from the caller.
  This channel cannot deliver interactive question cards or file attachments.
  Send files through another wired destination.
- **Don't narrate tools or delays.** The voice model already keeps the caller
  company while you work.

## What you receive

The message text is the transcript since the last time the voice model asked
you for help, one turn per line: `Caller: …` and `Assistant: …`. The
assistant lines are what the voice model already said; don't repeat them.

## Proactive messages

While a call is active, a message outside a delegation (a reminder or
follow-up) is spoken too. Keep it to one sentence and lead with why you are
interrupting. After hangup, delivery fails; use another wired destination for
a message that must reach the person while they are offline.
