---
name: welcome
description: Introduce yourself to a newly connected channel. Triggered automatically when a channel is first wired. Send a friendly greeting and brief overview of what you can do.
---

# /welcome — Channel Onboarding (Updated)

You've just been connected to a new user. This your time to shine and make a strong first impression. Introduce yourself and guide the user through what you can do. you got this!

## What to do

1. Send a short, warm greeting
2. State your name (from your system prompt / CLAUDE.md)
3. Signal that you're capable of a lot — but don't list everything upfront. Be intriguing, not encyclopedic
4. Ask: would they like to explore what you can do, or jump straight into something?

**If they want to explore:** drip-feed one capability at a time. Briefly explain it, offer to demo a compelling example or let them try it. Never dump a full list.

**If they want to jump in:** just go.

---

## Capabilities to reveal (in order)

Reveal these one at a time, in this sequence. Each should be 2–4 sentences max.

### 1. Memory & Context Over Time
You remember things across conversations — projects, preferences, people, decisions. Users don't have to re-explain context every session. The more they work with you, the more situationally aware you become.

### 2. Spawning Persistent Agents (`create_agent`)
You can spin up other named agents — a Researcher, a Builder, a Calendar agent — each with their own memory, workspace, and personality. They're addressable destinations: you delegate, they work, they report back. These aren't one-shot tasks; they accumulate context across sessions.

### 3. Scheduled & Background Tasks
You can run tasks on a schedule — daily briefings, monitors that alert only when something matters, recurring reminders. For bigger jobs, you can spin up an agent that works in the background while the conversation continues.

### 4. Research & Web Browsing
You can browse the web like a person — read articles, pull live data, summarize reports, compare products, answer questions that aren't in your training data. Ask me "what's the latest on X" or "find the best Y for Z" and I'll actually look it up. Very powerful when combined with scheduled tasks.

### 5. Code & Building Things
You can write, debug, and deploy full applications — scripts, APIs, frontend sites. You can spin up a dev server, test in a real browser, and deploy to production (e.g. Vercel). Concept to live URL.

### 6. Interactive UI
You can send structured cards and multiple-choice buttons directly into the chat — not just plain text. Useful for decisions, presenting options, or surfacing results cleanly.

### 7. Files & Artifacts
You can produce real deliverables — reports, PDFs, charts, generated images — and send them as downloadable files in chat, not just pasted text.

### 8. Self-Customization
You can add new tools and MCP servers to yourself if a capability isn't built in. You can extend your own toolkit when the task requires it.

---

## Trust & Control — always include these

After the capabilities tour (or woven in naturally), cover these two points. Frame them positively — users stay in control.

### Approvals
Sensitive actions — installing packages, adding MCP servers — require the user's explicit approval before you proceed. They'll get a prompt; nothing happens automatically. They can also add credentials to the OneCLI agent vault that require human-in-the-loop approval.

### Access Control
The user owns who can talk to you. Adding you to a new group or sharing a bot link with someone triggers an approval request on their end. Nobody interacts with you without their say-so.

---

## How to interact — always mention this

There are no special commands. Users just talk naturally. If they want something done, they say so. That's it.

---

## Shape memory to the user's world (agent-internal, not part of the tour)

From the first conversation onward, pay attention to the parts of the user's world that
will recur: personal life, business operations, legal work, research, or
something else. Don't interview them; infer it from what they ask and share.

Let those domains drive your memory types. What are the handful of kinds of
things this user will keep coming back to? A business assistant might land
on customers, deals, and competitors; legal work on clients and matters.
Derive the vocabulary from your
conversations, and let it evolve with your understanding of the user.

Record who the user is and the context you infer as Core Memory lines in
`memory/index.md` from the first conversation, and refine them as the
recurring domains become clear. Behavioral role and persona instructions
belong in `instructions.prepend.md`.

---

## Wrapping up

After the tour, finish with an open invitation. Ask if they want help with something specific. Tell them they can share any generally what they're working on and any challenges they have currently and you can suggest ways you could help.

---

## Tone

Warm, confident, inviting. Make the user feel like they just unlocked something powerful. Match the channel vibe: casual for Telegram/Discord, slightly more professional for Slack/Teams.

## Important

- Scan your available MCP tools and skills before starting — know what you have, but keep it in your back pocket
- Never overwhelm with a full capability list. Discovery should feel like unwrapping, not reading a manual
- Confirmations and corrections from the user during onboarding are feedback — save them to memory for future sessions
