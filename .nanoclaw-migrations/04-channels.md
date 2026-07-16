# 04 — Channel Adapters (Telegram + WhatsApp): local deltas only

**Base install is redone via skills.** Run `/add-telegram` and `/add-whatsapp` on the clean
checkout first. Those skills copy `src/channels/telegram.ts`, `telegram-pairing.ts`,
`telegram-markdown-sanitize.ts` (+ tests), `src/channels/whatsapp.ts`, `setup/groups.ts`,
setup helpers, and add the pinned deps (`@chat-adapter/telegram`, `@whiskeysockets/baileys`,
`pino`, `qrcode`, `@types/qrcode`) and the barrel imports in `src/channels/index.ts`
(`import './telegram.js'; import './whatsapp.js';`). All of that is **stock** — do not
port it from the old tree.

The comparison below is against `origin/channels` HEAD (post-restructure). The current
channels branch is AHEAD of what was installed locally (e.g. Telegram gained
`TELEGRAM_DEFAULTS`/`ChannelDefaults`, WhatsApp gained mentions support, media-failure
notes, safe-filename handling, shared/dedicated-mode helpers, auth-preservation shutdown
logic, LID mention detection). **Take the new upstream versions**; do NOT resurrect the
older local bodies. Only the deltas below are local customizations to reapply.

Files with **zero local delta** (pure stock, skip entirely):
`telegram-markdown-sanitize.ts`, `telegram-markdown-sanitize.test.ts`, `setup/groups.ts`,
`setup/channels/*`, `setup/pair-telegram.ts`, `setup/whatsapp-auth.ts`.

## 1. telegram-pairing.ts — accept `/start <code>` deep links (1 line + tests)

Intent: the setup pairing code can also arrive as a Telegram deep-link payload
(`/start 5091`), not just a bare 4-digit message.

In `extractCode` (`src/channels/telegram-pairing.ts`):

```ts
// before (stock):
  const m = candidate.match(/^(\d{4})$/);
// after (local):
  const m = candidate.match(/^(\d{4})$/) ?? candidate.match(/^\/start\s+(\d{4})$/);
```

Append to `src/channels/telegram-pairing.test.ts` inside `describe('extractCode', …)`:

```ts
  it('accepts /start <code> deep link format', () => {
    expect(extractCode('/start 5091', 'nanobot')).toBe('5091');
    expect(extractCode('/start 0042', 'nanobot')).toBe('0042');
  });
  it('rejects /start with non-4-digit payload', () => {
    expect(extractCode('/start 12345', 'nanobot')).toBeNull();
    expect(extractCode('/start hello', 'nanobot')).toBeNull();
    expect(extractCode('/start', 'nanobot')).toBeNull();
  });
```

## 2. telegram.ts — pilot-activation interceptor + related plumbing

Local customizations to weave into the **new stock** `telegram.ts` (the stock file already
has `readInboundFields`, `sendPairingConfirmation`, `createPairingInterceptor`; adapt names
to whatever the current file uses):

**(a) Import** the pilot module:

```ts
import { tryActivatePilot } from '../modules/pilot-activation/index.js';
```

**(b) `readInboundFields` also extracts the author display name** (needed by the pilot flow):

```ts
interface InboundFields {
  text: string;
  authorUserId: string | null;
  authorName: string | null;
}

function readInboundFields(message: InboundMessage): InboundFields {
  if (message.kind !== 'chat-sdk' || !message.content || typeof message.content !== 'object') {
    return { text: '', authorUserId: null, authorName: null };
  }
  const c = message.content as {
    text?: string;
    author?: { userId?: string; fullName?: string; userName?: string };
  };
  return {
    text: c.text ?? '',
    authorUserId: c.author?.userId ?? null,
    authorName: c.author?.fullName ?? c.author?.userName ?? null,
  };
}
```

**(c) Generalize the pairing-confirmation sender** to a reusable direct-text sender
(pilot feedback texts reuse it):

```ts
async function sendDirectText(token: string, platformId: string, text: string): Promise<void> {
  const chatId = platformId.split(':').slice(1).join(':');
  if (!chatId) return;
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text }),
    });
    if (!res.ok) {
      log.warn('Telegram direct send non-OK', { status: res.status });
    }
  } catch (err) {
    log.warn('Telegram direct send failed', { err });
  }
}

async function sendPairingConfirmation(token: string, platformId: string): Promise<void> {
  await sendDirectText(token, platformId, 'Pairing success! Head back to the NanoClaw installer to finish setup.');
}
```

**(d) Pilot check at the TOP of the inbound interceptor**, before the bot-username
lookup and before setup-pairing extraction (the interceptor factory receives the bot
`token`; stock signature is `createPairingInterceptor(botUsernamePromise, hostOnInbound, token)`
— keep whatever the current stock signature is, it just needs `token` in scope):

```ts
  return async (platformId, threadId, message) => {
    try {
      const { text, authorUserId, authorName } = readInboundFields(message);
      if (!text) {
        hostOnInbound(platformId, threadId, message);
        return;
      }

      // Pilot activation (/start <20-char code>) — checked before setup
      // pairing and independent of the bot-username lookup; the two code
      // formats are disjoint. Handled attempts are fully consumed here and
      // never reach the router or an agent.
      const activated = await tryActivatePilot({
        text,
        platformId,
        authorUserId,
        displayName: authorName,
        isGroup: isGroupPlatformId(platformId),
        sendText: (t) => sendDirectText(token, platformId, t),
      });
      if (activated) return;

      const botUsername = await botUsernamePromise;
      if (!botUsername) {
        hostOnInbound(platformId, threadId, message);
        return;
      }
      // ... rest of stock pairing logic unchanged
```

**(e) Paired-chat `unknown_sender_policy`.** Locally the messaging group created on
successful pairing uses `unknown_sender_policy: 'strict'` (pilot-safety choice: strangers
DMing the bot never spawn agent state). Stock now uses the channel-defaults value
(`TELEGRAM_DEFAULTS...unknownSenderPolicy`, i.e. `'request_approval'`). **Decide:** keep
`'strict'` to preserve current behavior on this install, or accept the new stock default.
If keeping local behavior, in the pairing-consume branch:

```ts
          unknown_sender_policy: 'strict',
```

**Upstream-restructure flag:** origin/channels' Telegram adapter now registers
`ChannelDefaults` and dropped nothing the pilot hook depends on, but the channels branch has
also moved to a per-instance webhook route registry. If the interceptor factory shape or
`registerChannelAdapter` options changed by the time you apply this, keep the *semantics*:
pilot check runs first on every inbound DM text, fully consumes matches, and falls through
otherwise.

## 3. whatsapp.ts — voice-note (PTT) rendering for opus/ogg (only local delta)

Everything else in the local `whatsapp.ts` is an older stock version — use the new stock
file. The single local customization, in `buildMediaMessage`'s audio branch (supports the
`voice-messages` container skill; agent-generated OpenAI TTS opus files render as native
WhatsApp voice notes):

```ts
  if (audioExts.includes(ext)) {
    // Opus/Ogg audio → render as a native WhatsApp voice note (PTT bubble with
    // a waveform), not a generic audio file. OpenAI TTS `opus` output and
    // WhatsApp voice notes are both Ogg/Opus. Other audio formats (mp3, m4a,
    // wav, aac) stay as regular audio attachments.
    if (ext === '.opus' || ext === '.ogg') {
      return { audio: data, mimetype: 'audio/ogg; codecs=opus', ptt: true };
    }
    return { audio: data, mimetype: `audio/${ext.slice(1) === 'mp3' ? 'mpeg' : ext.slice(1)}` };
  }
```

Note: stock maps `.ogg` inbound audio already; this delta only affects **outbound** files.
Ensure `.opus` and `.ogg` are present in the file's `audioExts` list (check the stock list;
add `.opus` if missing).

## 4. Behavior differences you inherit by upgrading (informational, no action)

- WhatsApp: shared-vs-dedicated number mode is now explicit (`ASSISTANT_HAS_OWN_NUMBER`),
  auth is preserved across restarts (no more forced re-pair), `@phone` mentions are
  supported, unsafe attachment filenames are rejected, media download failures surface as
  text. All improvements — keep them.
- Telegram: channel defaults (`unknownSenderPolicy: 'request_approval'`) — see 2(e).
- This install runs Telegram as the pilot bot (@shellanoo_bot / Nanoco_pilot_bot via
  `PILOT_BOT_USERNAME`); `.env` `TELEGRAM_BOT_TOKEN` is installation config, not code.
