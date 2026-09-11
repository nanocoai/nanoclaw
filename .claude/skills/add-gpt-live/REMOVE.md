# Remove GPT-Live Channel

Reverses `/add-gpt-live`. Every step is idempotent — safe to re-run, and safe
when only partially installed (skip any step whose target is already absent).

## 1. Delete the barrel import

Remove the self-registration line from `src/channels/index.ts` (delete it, do
not comment it out):

```bash
sed -i.bak "/^import '\.\/gpt-live\.js';$/d" src/channels/index.ts && rm -f src/channels/index.ts.bak
```

## 2. Remove the copied files

The adapter, its state machine, and both tests:

```bash
rm -f src/channels/gpt-live.ts src/channels/gpt-live-session.ts src/channels/gpt-live-session.test.ts src/channels/gpt-live-registration.test.ts
```

## 3. Remove the container skill

`container/skills/` is a read-only mount; the per-group skill symlink is pruned
on the next spawn:

```bash
rm -rf container/skills/gpt-live-formatting
```

## 4. Remove the environment keys

`OPENAI_API_KEY` is removed only if nothing else on this install uses it
(check `.env` for other OpenAI consumers first, for example a Codex provider
set up outside OneCLI):

```bash
sed -i.bak '/^GPT_LIVE_PUBLIC_URL=/d;/^GPT_LIVE_VOICE=/d' .env && rm -f .env.bak
# only if no other consumer:
# sed -i.bak '/^OPENAI_API_KEY=/d' .env && rm -f .env.bak
```

## 5. Rebuild and restart

```bash
pnpm run build
bash setup/lib/restart.sh
```

Messaging groups and wirings created for `gpt-live` are runtime data; delete
them with `ncl wirings delete` and `ncl messaging-groups delete` if you no
longer want them listed. The OpenAI project, its key, and any SIP trunk are
managed on OpenAI's and the trunk provider's side.
