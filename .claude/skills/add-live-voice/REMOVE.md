# Remove Live Voice

Reverses `/add-live-voice`. Every step is idempotent — safe to re-run, and safe
when only partially installed (skip any step whose target is already absent).

## 1. Delete the barrel import

Remove the self-registration line from `src/channels/index.ts` (delete it, do
not comment it out):

```bash
sed -i.bak "/^import '\.\/gpt-live\.js';$/d" src/channels/index.ts && rm -f src/channels/index.ts.bak
```

## 2. Remove the copied files

The adapter, its state machine, prompt composer, call page, sideband, Keychain
reader, and the four tests:

```bash
rm -f src/channels/gpt-live.ts src/channels/gpt-live-session.ts src/channels/gpt-live-prompt.ts src/channels/gpt-live-call-page.ts src/channels/gpt-live-keychain.ts src/channels/gpt-live-sideband.ts src/channels/gpt-live-session.test.ts src/channels/gpt-live-adapter.test.ts src/channels/gpt-live-keychain.test.ts src/channels/gpt-live-registration.test.ts
```

## 3. Remove the container skill

`container/skills/` is a read-only mount; the per-group skill symlink is pruned
on the next spawn:

```bash
rm -rf container/skills/live-voice-formatting
```

## 4. Remove the environment keys

`OPENAI_API_KEY` is removed only if nothing else on this install uses it
(check `.env` for other OpenAI consumers first):

```bash
sed -i.bak '/^GPT_LIVE_PUBLIC_URL=/d;/^GPT_LIVE_VOICE=/d;/^GPT_LIVE_LINK_TOKEN=/d;/^GPT_LIVE_AGENT_NAME=/d;/^GPT_LIVE_KEYCHAIN_SERVICE=/d;/^GPT_LIVE_KEYCHAIN_ACCOUNT=/d' .env && rm -f .env.bak
# only if no other consumer:
# sed -i.bak '/^OPENAI_API_KEY=/d' .env && rm -f .env.bak
```

If the key was kept in the macOS Keychain, the item is the user's to remove:
`security delete-generic-password -s nanoclaw-openai -a "$USER"`.

## 5. Rebuild and restart

```bash
pnpm run build
bash setup/lib/restart.sh
```

The voice line's messaging group and wiring are runtime data; delete them with
`ncl wirings delete` and `ncl messaging-groups delete` if you no longer want
them listed. The OpenAI project and its key are managed on OpenAI's side.
