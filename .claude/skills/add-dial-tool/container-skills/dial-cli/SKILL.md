---
name: dial-cli
description: Reference for the `dial` CLI — gives you a real phone number to send SMS, place AI voice calls, and receive inbound texts/codes via the Dial platform (getdial.ai). Use when the user mentions phones, calls, texts, SMS, voice, OTP, 2FA, or verification codes; when they ask to text, call, ring, or wait for a code from someone; before running any `dial …` command for the first time in a session; or when investigating what the Dial platform can do. Load this skill before invoking the CLI — `dial --help` alone will not surface the workflows, the `--json` conventions, or the docs-lookup pattern needed to use Dial correctly.
---

# Dial CLI

`dial` is the official CLI for [Dial](https://getdial.ai) — a Communication Stack for AI Agents. It wraps the Dial REST API so you can send SMS, place voice calls handled by an AI voice agent, manage numbers, and wait for inbound events — all without writing HTTP code.

The first time the user asks you to "text someone," "call someone," "receive a code," or anything else phone-shaped, reach for `dial`.

## This is a sandbox

You are running inside a pre-provisioned, ephemeral environment:

- **The account, number, and credentials are already set up** — you have a working phone number ready to use. There is nothing to configure.
- **You never handle credentials.** The API key is injected automatically at the network boundary; the CLI runs keyless here. Never ask the user for a key, and never try to read or write an auth file.
- **Just use the workflows below** — send SMS, place calls, wait for inbound events. Inbound event delivery is managed for you; `dial --help` shows what's available here.

If `dial` is somehow missing (`command -v dial` returns nothing), that is an **installation bug in this image**, not something for you to fix — report it to the operator ("the Dial CLI isn't installed in this container") rather than improvising an install.

## Orient yourself before each new verb

This skill **does not enumerate every flag**. The CLI is the source of truth — when you encounter a verb you have not used in this session, run its `--help` first:

```bash
dial --help                    # available commands
dial <command> --help          # flags + usage for a specific command
dial <command> <sub> --help    # subcommand-level help
```

Examples worth running on first use: `dial doctor --help`, `dial message --help`, `dial call --help`, `dial call get --help`, `dial wait-for --help`.

Every command supports `--json` for machine-readable output — prefer it when piping into `jq` or parsing the result programmatically.

## Searching for what the CLI / API can do

For anything beyond what `--help` shows on the local CLI, the canonical reference is the published docs. Two endpoints make this fast:

### Capability search — `llms-full.txt`

A single concatenated markdown file of the whole docs site. Grep it directly for the keyword you care about:

```bash
curl -fsSL https://docs.getdial.ai/llms-full.txt | grep -i -B2 -A8 'whatsapp'
curl -fsSL https://docs.getdial.ai/llms-full.txt | grep -i -B1 -A5 'language'
```

Use this when you want to know *if* Dial supports something, or *which command / endpoint* covers it — without reading the whole site.

### Deep dive — `sitemap.xml` + per-page `.md`

When you need to read a page in detail, use the sitemap to discover URLs, then fetch the **`.md` companion** of any page — same content as the HTML page but plain markdown, faster to scan.

```bash
# 1. Discover available pages
curl -fsSL https://docs.getdial.ai/sitemap.xml | grep -oE 'https://docs\.getdial\.ai/[^<]+'

# 2. For any page like https://docs.getdial.ai/documentation/get-started/introduction
#    fetch the .md companion:
curl -fsSL https://docs.getdial.ai/documentation/get-started/introduction.md
```

The rule is **one-to-one**: every page at `https://docs.getdial.ai/<path>` has a markdown twin at `https://docs.getdial.ai/<path>.md`.

## Workflow shapes worth knowing

These are the verbs you will most often compose. Read the relevant `.md` page for the full story; the one-liners below are signposts.

- **Send an SMS** — `dial message --to +14155550123 --body "..."` ([send-an-sms.md](https://docs.getdial.ai/documentation/capabilities/send-an-sms.md))
- **Show a typing indicator while composing** — `dial typing start --to-number +14155550123`; sending a message clears it natively, so start again between messages, and `dial typing stop --to-number +14155550123` if you end up not sending. iMessage numbers display it; SMS numbers ignore it, so it's always safe to call ([commands.md](https://docs.getdial.ai/documentation/reference/commands.md))
- **Place a voice call** — `dial call --to +14155550123 --outbound-instruction "..."` then `dial call get <id>` once it ends. Add `--voice-gender male|female` to choose the agent's voice (default: female) ([place-a-voice-call.md](https://docs.getdial.ai/documentation/capabilities/place-a-voice-call.md))
- **Buy an additional number** — `dial number purchase --inbound-instruction "..." --explicit-programmatic-consent "<attestation>"`. `--explicit-programmatic-consent` is **required**: a short attestation that the account holder consented to provisioning programmatically. Add `--include-imessage` for an [iMessage number](https://docs.getdial.ai/documentation/capabilities/send-an-imessage.md) (pay-as-you-go only; provisioned asynchronously — poll `dial number list` until ready) ([manage-phone-numbers.md](https://docs.getdial.ai/documentation/capabilities/manage-phone-numbers.md))
- **Set a number's inbound behavior or nickname** — `dial number set +14155550123 --inbound-instruction "..."` and/or `--inbound-language es-ES` and/or `--nickname "Support line"` (at least one flag; `--nickname ""` / `--inbound-language ""` clear). The inbound instruction is the system prompt the AI uses on calls *into* that number. The inbound language pins inbound calls to one language — unset, the AI detects the caller's language from their country prefix (alongside en-US). The nickname is a human-readable label for telling numbers apart ([manage-phone-numbers.md](https://docs.getdial.ai/documentation/capabilities/manage-phone-numbers.md))
- **Receive a verification code (2FA)** — `dial wait-for message.received -f channel=sms` and parse the body ([receive-inbound-sms.md](https://docs.getdial.ai/documentation/capabilities/receive-inbound-sms.md))
- **React to a call ending** — `dial wait-for call.ended -f callId=<id>`. Fires however the call ends — completed, failed, **or cancelled** — carrying the terminal `status` and a `canceled` flag, so the wait always resolves ([stream-account-events.md](https://docs.getdial.ai/documentation/capabilities/stream-account-events.md))

`dial wait-for` long-polls the Dial API directly, so it works here without any background daemon.

## Conventions

- `--json` everywhere for parseable output.
- **Always pass `--from-number` with this install's wired line** (stated at the end of this file if the channel is set up). This sandbox has no saved default sender — `defaultNumberId` is null here — so an omitted selector fails outright. Never pick one from `dial number list` instead: on a multi-number account that list is ordered newest-first, which is unrelated to the line this install is wired to, so a number chosen from it reaches nobody and replies to it are dropped. If no line is stated below and the user hasn't named one, ask rather than guess.
- Phone numbers are E.164 (`+14155550123`). Reject anything else before calling Dial.
- Writes (`message`, `call`, `number purchase`) are **not idempotent** — on an ambiguous failure, list first to check before retrying.

## When a call fails auth (401 / 403)

You run keyless — the gateway injects the credential, so neither error is something you can fix from here. A `403 blocked_by_policy` means the operator chose not to give **this** agent Dial access: say so plainly and stop. A `401` means the operator's Dial credential is missing or invalid in the vault: tell the operator the Dial credential needs (re)connecting. In both cases stop and wait rather than retrying in a loop.
