---
name: slack-bots
description: PR Factory component — add the supervisor and tester Slack bot adapters as named channel instances ('slack-supervisor', 'slack-tester') alongside the stock /add-slack worker bot, with shared sibling-bot echo suppression so the three bots never echo-loop each other, sibling-mention suppression for sticky threads, and an upgrade migration for legacy bot_id-shaped DBs.
---

# slack-bots (PR Factory component)

Runs two extra Slack bot identities alongside the stock `/add-slack` worker bot, on core's native channel-instance substrate:

- **`slack-supervisor`** (`src/channels/slack-supervisor.ts`) — instance `'slack-supervisor'` (exported as `SUPERVISOR_INSTANCE`), webhook `/webhook/slack-supervisor`, env `SLACK_SUPERVISOR_BOT_TOKEN` / `SLACK_SUPERVISOR_SIGNING_SECRET`.
- **`slack-tester`** (`src/channels/slack-tester.ts`) — instance `'slack-tester'` (exported as `TESTER_INSTANCE`), webhook `/webhook/slack-tester`, env `SLACK_TESTER_BOT_TOKEN` / `SLACK_TESTER_SIGNING_SECRET`.
- **`src/channels/slack-bot-ids.ts`** — a shared module-level `Set` of Slack bot user IDs, `registerSlackBotUserId(token, label)` (resolves a bot's user id via Slack `auth.test`), and `withSiblingEchoGuard(bridge, ids)`. Every Slack adapter (worker, supervisor, tester) pushes its own id into the Set at factory time and returns its bridge wrapped in the guard — each bot silently drops inbound messages authored by its siblings, across **all four** Chat SDK dispatch paths (subscribed, new-mention, DM, plain), preventing cross-bot echo loops in shared channels. Trade-off (documented in the file header): a sibling message's attachments are downloaded before the drop.
- **`src/channels/sibling-mention.ts`** — `hasSiblingMention(mg, text)`: suppresses a mention-sticky follow-up that starts with `@` when a sibling named-instance mention-mode bot shares the channel (the `@` is addressed to the sibling; without this, the supervisor's sticky thread would also fire on every `@pr-tester ...` message).
- **`src/db/migrations/module-slack-bots-bot-id-to-instance.ts`** — legacy-upgrade migration: converts a `bot_id`-shaped multi-bot DB (the legacy pre-instance substrate) to migration 016's instance schema, including the Chat SDK state-namespace rewrite. Pure no-op on fresh installs.

Each adapter self-registers on import and is inert when its bot token is unset.

**Cross-component export contract.** `SUPERVISOR_INSTANCE` and `TESTER_INSTANCE` are the single owners of the `'slack-supervisor'` / `'slack-tester'` instance strings. The `pr-factory-core` component imports both; the webhook routes (`/webhook/<instance>`) and Chat SDK state namespaces derive from them. Keep the exports stable.

Integration surface: two appended barrel lines in `src/channels/index.ts`, one 3-line patch into the skill-installed `src/channels/slack.ts`, one one-line suppression hunk (+ import) in `src/router.ts`, one barrel insert in `src/db/migrations/index.ts`, and four `.env` reads. Everything else is added files.

## Prerequisites

Probe each before applying; stop on a failed probe and do what it names first.

1. **`/add-slack` is applied** — the worker bot exists and this skill patches its factory:

   ```bash
   test -f src/channels/slack.ts && grep -q '"@chat-adapter/slack"' package.json && echo OK
   ```

   If it fails: run `/add-slack`, then return here.

2. **Core ships the channel-instance substrate** (nanoclaw ≥ 2.1.11) — the adapters pass `instance` to `createChatSdkBridge`, the registry keys by instance, and `messaging_groups` carries the `instance` column:

   ```bash
   grep -q 'instance?: string' src/channels/adapter.ts && test -f src/db/migrations/016-messaging-group-instance.ts && echo OK
   ```

   If it fails: **stop — update core to a version that ships the native channel-instance substrate (nanoclaw ≥ 2.1.11) first.** This skill makes no core edits to substitute for it.

3. **Two additional Slack apps** in the same workspace as the worker bot (created in the Credentials section below), with their bot tokens and signing secrets at hand.

Each step below is idempotent: if the file already contains the patched form, leave it as is and continue.

## Apply

All copy sources are under this component's folder; run every command from the repo root:

```bash
SKILL=.claude/skills/recipes/pr-factory/skills/slack-bots
```

### 1. Copy the skill-owned modules

```bash
cp $SKILL/files/src/channels/slack-bot-ids.ts src/channels/slack-bot-ids.ts
cp $SKILL/files/src/channels/slack-supervisor.ts src/channels/slack-supervisor.ts
cp $SKILL/files/src/channels/slack-tester.ts src/channels/slack-tester.ts
cp $SKILL/files/src/channels/sibling-mention.ts src/channels/sibling-mention.ts
cp $SKILL/files/src/db/migrations/module-slack-bots-bot-id-to-instance.ts src/db/migrations/module-slack-bots-bot-id-to-instance.ts
```

### 2. Append the self-registration imports

Append to `src/channels/index.ts` (skip any line already present):

```typescript
import './slack-supervisor.js';
import './slack-tester.js';
```

### 3. Patch the worker adapter (`src/channels/slack.ts`)

Three lines into the stock `/add-slack` file, so the worker joins the shared sibling-suppression Set and gets the echo guard.

> **Do not re-run `/add-slack`'s copy step after this.** `/add-slack` rewrites `src/channels/slack.ts` from scratch, silently dropping these three lines — the worker then echo-loops with its siblings. `src/channels/slack-ignore-senders.test.ts` catches it (the factory's `auth.test` registration no longer lands in the shared Set), but re-apply this patch immediately if you ever re-run `/add-slack`.

**3a.** Append to the import block (skip if already present):

```typescript
import { slackBotUserIds, registerSlackBotUserId, withSiblingEchoGuard } from './slack-bot-ids.js';
```

**3b.** In the factory, insert immediately after the `createSlackAdapter(...)` statement:

```typescript
    void registerSlackBotUserId(env.SLACK_BOT_TOKEN, 'worker');
```

**3c.** Change the factory's final `return bridge;` to:

```typescript
    return withSiblingEchoGuard(bridge, slackBotUserIds);
```

If the stock file's shape has drifted cosmetically (formatting, extra config fields), apply the same three semantic edits and leave every other line (e.g. the `resolveChannelName` block) untouched.

### 4. Router suppression hunk (`src/router.ts`)

**4a.** Append to the import block (skip if already present):

```typescript
import { hasSiblingMention } from './channels/sibling-mention.js';
```

**4b.** In `evaluateEngage`, the `'mention-sticky'` case reads:

```typescript
      if (mg.is_group === 0) return false; // DMs never use mention-sticky sensibly
      const existing = findSessionForAgent(agent.agent_group_id, mg.id, threadId);
```

Insert one line between them:

```typescript
      if (mg.is_group === 0) return false; // DMs never use mention-sticky sensibly
      // Suppress if the message mentions a sibling bot on the same channel.
      if (hasSiblingMention(mg, text)) return false;
      const existing = findSessionForAgent(agent.agent_group_id, mg.id, threadId);
```

### 5. Register the legacy-upgrade migration (`src/db/migrations/index.ts`)

**5a.** Append to the import block (skip if already present):

```typescript
import { moduleSlackBotsBotIdToInstance } from './module-slack-bots-bot-id-to-instance.js';
```

**5b.** In the `migrations` array, insert `moduleSlackBotsBotIdToInstance,` **immediately before `migration016,`**. The ordering is load-bearing: on a DB shaped by the legacy `bot_id` substrate, 016's recreate would silently drop `bot_id` and then collide on `UNIQUE(channel_type, platform_id, instance)` — a boot crash-loop. On fresh DBs the migration is a guarded no-op.

### 6. Copy the guard tests

```bash
cp $SKILL/files/src/channels/multibot-registration.test.ts src/channels/multibot-registration.test.ts
cp $SKILL/files/src/channels/slack-ignore-senders.test.ts src/channels/slack-ignore-senders.test.ts
cp $SKILL/files/src/router-sibling-mention.test.ts src/router-sibling-mention.test.ts
cp $SKILL/files/src/db/slack-bots-migration.test.ts src/db/slack-bots-migration.test.ts
```

| Test | Guards |
|------|--------|
| `src/channels/multibot-registration.test.ts` | Both barrel imports (real-barrel registration assertion), the unmocked `@chat-adapter/slack` dependency, and the `SUPERVISOR_INSTANCE`/`TESTER_INSTANCE` export contract |
| `src/channels/slack-ignore-senders.test.ts` | The slack.ts 3-line delta, behaviorally: the factory's `auth.test` registration lands in the shared Set, the guard drops sibling-authored messages (incl. the DM dispatch path) via live Set identity through the real Chat SDK dispatch, and all three adapters resolve by exact instance key with `channelType === 'slack'` (no cross-instance hijack) |
| `src/router-sibling-mention.test.ts` | The router's one-line `hasSiblingMention` call at the mention-sticky seam + the helper's instance-keyed sibling query, via the real `routeInbound` on a real migrated DB |
| `src/db/slack-bots-migration.test.ts` | The migration's barrel presence AND its before-016 ordering, the bot_id→instance mapping, the chat_sdk namespace rewrite (leading-prefix-only), lock clearing, idempotence, and the fresh-DB no-op |

## Credentials

### Create the two Slack apps

Repeat the **Credentials** section of the `/add-slack` skill twice — once for a "PR Supervisor" app and once for a "PR Tester" app, in the **same workspace** as the worker bot. Same bot token scopes, Messages Tab, and Interactivity settings. The only difference is the webhook URL each app posts to:

- Supervisor app — Event Subscriptions and Interactivity **Request URL**: `https://your-domain/webhook/slack-supervisor`
- Tester app — Event Subscriptions and Interactivity **Request URL**: `https://your-domain/webhook/slack-tester`

(The worker app stays on `/webhook/slack`. The shared webhook server serves all three paths on the same port.)

### Configure environment

Add to `.env`:

```bash
SLACK_SUPERVISOR_BOT_TOKEN=xoxb-supervisor-bot-token
SLACK_SUPERVISOR_SIGNING_SECRET=supervisor-signing-secret
SLACK_TESTER_BOT_TOKEN=xoxb-tester-bot-token
SLACK_TESTER_SIGNING_SECRET=tester-signing-secret
```

## Using it

Wire each bot's `messaging_groups` row with the matching `instance` (`slack-supervisor` / `slack-tester`; the worker uses the default instance, which is the literal value `slack`). The `pr-factory-core` component's bootstrap creates these wirings itself. A bot with no wired row engages nothing: inbound auto-creates an unwired per-instance messaging group with `unknown_sender_policy = 'request_approval'`.

Restart the host after applying so the new adapters connect.

## Upgrading a legacy bot_id install

If the install previously ran the legacy pre-instance multi-bot substrate (`messaging_groups.bot_id`, namespace-prefixed `chat_sdk_*` keys), the copied migration converts everything at next boot: `bot_id NULL → instance = channel_type`, `'pr-supervisor' → 'slack-supervisor'`, `'pr-tester' → 'slack-tester'`, Chat SDK keys re-namespaced (worker unprefixed, named instances renamed), `chat_sdk_locks` cleared (TTL-bound; expect at most one re-@mention per subscribed thread). Webhook URLs are byte-identical to the legacy install's, so the Slack app consoles need zero changes. **Do not boot a tree without this skill applied on such a DB** — bare 016 crash-loops on it (see the migration header).

## Known smell (declared)

`src/channels/sibling-mention.ts` performs a raw SQL read against the core central DB (`messaging_groups` joined to `messaging_group_agents`) — skill-guidelines anti-pattern #4. The logic lives in the skill-owned file so the core touch is a one-line call, but the clean fix is a core helper in `src/db/messaging-groups.ts` (e.g. `countSiblingMentionBots(channelType, platformId, instance)`), a natural follow-on to the channel-instance substrate. Until then the query lives here, guarded by `src/router-sibling-mention.test.ts`.

## Validate

```bash
pnpm run build
pnpm test
pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit
cd container/agent-runner && bun test; cd ../..
```

All suites green. Any failure means a step didn't apply cleanly.

## Channel Info

- **type**: `slack` (both adapters reuse the Slack channel type; they register under their instance names)
- **registry keys**: `slack-supervisor`, `slack-tester` (the worker stays on the default key `slack`)
- **platform-id-format**: same as `/add-slack` (`slack:{channelId}`); disambiguation happens via `messaging_groups.instance`, not the platform id
- **supports-threads**: yes
- **typical-use**: the PR Factory supervisor/tester/worker trio — separate bot identities for triage oversight and test orchestration in the same channels the worker posts to
