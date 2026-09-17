# Remove slack-bots (PR Factory component)

Deletes the five skill-owned modules and the four guard tests, removes the two barrel lines, reverts the 3-line patch in `src/channels/slack.ts`, the router suppression hunk, and the migrations-barrel insert. Each step is idempotent: if the file already has the stock form, leave it as is and continue.

> **Remove dependents first.** The `pr-factory-core` component imports `SUPERVISOR_INSTANCE` from `src/channels/slack-supervisor.ts` and `TESTER_INSTANCE` from `src/channels/slack-tester.ts`. Removing this component while `pr-factory-core` is installed breaks the build. Remove `pr-factory-core` first.
>
> **Data notes.**
> - `messaging_groups` rows with `instance` `'slack-supervisor'` or `'slack-tester'` reference adapters that no longer run. Outbound delivery for their sessions is exact-key, so it gets the normal offline-adapter handling (warn + retry path) — it never falls back through the worker bot. Inbound from the removed apps stops arriving once the apps are disabled. Delete or re-wire those rows (and their wirings/sessions) when removing for good — use the `pnpm run ncl` group/wiring verbs, not raw SQL.
> - If the legacy-upgrade migration already ran on this DB, its `schema_version` row (`module-slack-bots-bot-id-to-instance`) and the converted data stay — the conversion is forward-only and matches core's own 016 schema, so nothing needs reversing.

## 1. Delete the skill-owned files and tests

```bash
rm -f src/channels/slack-supervisor.ts
rm -f src/channels/slack-tester.ts
rm -f src/channels/slack-bot-ids.ts
rm -f src/channels/sibling-mention.ts
rm -f src/db/migrations/module-slack-bots-bot-id-to-instance.ts
rm -f src/channels/multibot-registration.test.ts
rm -f src/channels/slack-ignore-senders.test.ts
rm -f src/router-sibling-mention.test.ts
rm -f src/db/slack-bots-migration.test.ts
```

## 2. Delete the barrel imports (`src/channels/index.ts`)

Delete (not comment out) both lines:

```typescript
import './slack-supervisor.js';
import './slack-tester.js';
```

## 3. Revert the worker adapter patch (`src/channels/slack.ts`)

Delete the import line:

```typescript
import { slackBotUserIds, registerSlackBotUserId, withSiblingEchoGuard } from './slack-bot-ids.js';
```

Delete the `void registerSlackBotUserId(env.SLACK_BOT_TOKEN, 'worker');` line, and change the factory's final return back to:

```typescript
    return bridge;
```

Leave every other line (e.g. the `resolveChannelName` block) untouched — it belongs to the stock `/add-slack` file.

## 4. Revert the router hunk (`src/router.ts`)

Delete the import line:

```typescript
import { hasSiblingMention } from './channels/sibling-mention.js';
```

In `evaluateEngage`'s `'mention-sticky'` case, delete the comment and the call:

```typescript
      // Suppress if the message mentions a sibling bot on the same channel.
      if (hasSiblingMention(mg, text)) return false;
```

## 5. Revert the migrations barrel (`src/db/migrations/index.ts`)

Delete the import line:

```typescript
import { moduleSlackBotsBotIdToInstance } from './module-slack-bots-bot-id-to-instance.js';
```

and the `moduleSlackBotsBotIdToInstance,` entry (plus its ordering comment block, if present) from the `migrations` array.

## 6. Remove the environment lines

Delete these four lines from `.env`:

```bash
SLACK_SUPERVISOR_BOT_TOKEN=...
SLACK_SUPERVISOR_SIGNING_SECRET=...
SLACK_TESTER_BOT_TOKEN=...
SLACK_TESTER_SIGNING_SECRET=...
```

## 7. Slack side

Disable or uninstall the "PR Supervisor" and "PR Tester" Slack apps in the workspace (events posted to `/webhook/slack-supervisor` and `/webhook/slack-tester` now get a 404).

## 8. Validate

> **Skip this step during full-recipe removal.** Removing the whole PR Factory? This runs last in the reverse order, but the recipe-level validation is the binding one — run this block only when removing `slack-bots` in isolation.

```bash
pnpm run build
pnpm test
pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit
cd container/agent-runner && bun test; cd ../..
```

All suites green.

Note: if this component's folder (`.claude/skills/recipes/pr-factory/skills/slack-bots/`) stays committed after removal, the skill-sync drift guard (`src/skill-sync.test.ts`) goes red on the now-missing in-tree files — delete the folder (the clean path) or remove/amend its `files.txt`.
