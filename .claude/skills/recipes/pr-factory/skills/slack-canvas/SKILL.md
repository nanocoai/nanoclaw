---
name: slack-canvas
description: PR Factory component — render PR Factory markdown as Slack Canvases. Registers a canvas provider on pr-factory-core's canvas seam (test plans and results become shared canvases instead of .md uploads) and adds a delivery file-transform hook to core so the worker's .md outbox attachments deliver as inline canvas links.
---

# slack-canvas (PR Factory component)

Inline documents instead of downloadable files. `pr-factory-core` calls `createCanvas` for test plans and test results and falls back to plain text + `.md` upload when no provider is registered; the worker's review writeups otherwise deliver as raw `.md` attachments. With this component:

1. **Canvas provider** — `src/modules/pr-factory/slack-canvas.ts` registers the Slack Canvas API client on core's seam (`canvases.create` → `canvases.access.set` → `files.info` permalink, numbered lists sanitized to bullets). Test plans and results render as canvases shared into the channel.
2. **Delivery file transform** — the same file registers a transform on `registerFileTransform` (the delivery hook this component's apply adds to core): `.md` outbox attachments from the PR Factory worker's Slack sessions convert to canvas links appended to the message text (`review-pr-42.md` → "Review — PR #42" + `[View review](permalink)`); non-`.md` files, non-worker sessions, and provider failures pass through / fall back to the original upload.

Skill-owned file: `src/modules/pr-factory/slack-canvas.ts`. Integration surface: one appended barrel line in `src/modules/index.ts` and **one core reach-in** — the file-transform hook in `src/delivery.ts` (three edits, exact shapes below). No new dependencies (built-in `fetch`; the worker bot token is reused via core's `getBotToken`).

## Prerequisites

Probe each before applying; stop on a failed probe and do what it names first.

1. **The `pr-factory-core` component is applied** (this component registers on its canvas seam and scopes by its worker group):

   ```bash
   grep -q 'export function registerCanvasProvider' src/modules/pr-factory/canvas.ts && echo OK
   ```

   If it fails: apply the `pr-factory-core` component first.

2. **The worker Slack app can use the Canvas API**: in the `/add-slack` app's OAuth scopes, add `canvases:write` and `files:read` (then reinstall the app to the workspace). Canvases also require a paid Slack plan — on free plans `canvases.create` fails and everything falls back to `.md` uploads (the component stays harmless).

Each step below is idempotent: if the file already contains the patched form, leave it as is and continue.

## Apply

All copy sources are under this component's folder; run every command from the repo root:

```bash
SKILL=.claude/skills/recipes/pr-factory/skills/slack-canvas
```

### 1. Copy the module

```bash
cp $SKILL/files/src/modules/pr-factory/slack-canvas.ts src/modules/pr-factory/slack-canvas.ts
```

### 2. Add the file-transform hook to `src/delivery.ts` (the core reach-in)

**2a.** Append the hook infrastructure immediately after the `getDeliveryAction` function:

```typescript
/**
 * File transform hook — lets a module intercept outbound file attachments
 * before delivery (e.g. converting .md files to Slack Canvases).
 *
 * The transform receives the session, the parsed message content, and the
 * resolved outbox files. It returns { files, content } — either unchanged or
 * with files removed and content modified (e.g. a canvas link appended to
 * the text).
 *
 * Single-slot: one transform at a time; a later registrant replaces the
 * earlier one. An ordered transform chain is the natural upgrade if a second
 * consumer ever appears.
 */
export type FileTransformFn = (
  session: Session,
  content: Record<string, unknown>,
  files: OutboundFile[],
) => Promise<{ files?: OutboundFile[]; content: Record<string, unknown> }>;

let fileTransform: FileTransformFn | null = null;

export function registerFileTransform(transform: FileTransformFn): void {
  fileTransform = transform;
}
```

(`Session` and `OutboundFile` are already imported at the top of delivery.ts.)

**2b.** In `deliverMessage`, the outbox-files block reads:

```typescript
  const files =
    Array.isArray(content.files) && content.files.length > 0
      ? readOutboxFiles(session.agent_group_id, session.id, msg.id, content.files as string[])
      : undefined;

  const platformMsgId = await deliveryAdapter.deliver(
    msg.channel_type,
    msg.platform_id,
    msg.thread_id,
    msg.kind,
    msg.content,
    files,
    deliverInstance,
  );
```

Change `const files` to `let files`, insert the transform application between the two statements, and pass `deliveryContent` instead of `msg.content` — keeping `deliverInstance` as the 7th argument:

```typescript
  let files =
    Array.isArray(content.files) && content.files.length > 0
      ? readOutboxFiles(session.agent_group_id, session.id, msg.id, content.files as string[])
      : undefined;

  // Apply the file transform hook (e.g. converting .md files to Slack
  // Canvases). Best-effort: a throwing transform falls back to delivering
  // the original message untouched.
  let deliveryContent = msg.content;
  if (fileTransform && files && files.length > 0) {
    try {
      const result = await fileTransform(session, content, files);
      files = result.files;
      deliveryContent = JSON.stringify(result.content);
      // eslint-disable-next-line no-catch-all/no-catch-all -- transform is best-effort by contract; the untransformed message still delivers
    } catch (err) {
      log.warn('File transform failed, delivering original', { err, sessionId: session.id });
    }
  }

  const platformMsgId = await deliveryAdapter.deliver(
    msg.channel_type,
    msg.platform_id,
    msg.thread_id,
    msg.kind,
    deliveryContent,
    files,
    deliverInstance,
  );
```

If the surrounding code has drifted cosmetically, apply the same three semantic edits (mutable `files`, the guarded transform block, `deliveryContent` in the deliver call) and leave every other line untouched.

### 3. Append the modules-barrel line (`src/modules/index.ts`)

After the `import './pr-factory/index.js';` line, append (skip if already present):

```typescript
import './pr-factory/slack-canvas.js';
```

### 4. Copy the guard test

```bash
cp $SKILL/files/src/modules/pr-factory/file-transform.test.ts src/modules/pr-factory/file-transform.test.ts
```

| Test | Guards |
|------|--------|
| `src/modules/pr-factory/file-transform.test.ts` | The delivery reach-in behaviorally (REAL modules barrel + real bootstrap + real `deliverSessionMessages` over on-disk session DBs; Slack's canvas APIs are the only fake): a worker-session `.md` outbox file becomes a canvas link with the file stripped and the default-instance 7th arg intact; non-worker sessions pass through untouched (named-instance fixture); a throwing transform falls back to the original message; plus the provider registration through core's `createCanvas` seam |

## Known smell (declared)

**Single-slot file transform.** `registerFileTransform` holds ONE transform; a second registrant silently clobbers the canvas conversion. The guard test's worker-session leg doubles as the composed-stack assertion: any other module registering a transform turns it red. If a second consumer ever appears, the slot must become an ordered chain in core first.

## Validate

```bash
pnpm run build
pnpm test
```

All green. Any failure means a step didn't apply cleanly.
