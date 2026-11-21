# Remove slack-canvas

Reverses every change the apply made. After removal, test plans/results and worker reviews fall back to plain text + `.md` file uploads (core's built-in fallback paths).

## 1. Delete the copied files

```bash
rm -f src/modules/pr-factory/slack-canvas.ts
rm -f src/modules/pr-factory/file-transform.test.ts
```

## 2. Delete the barrel line

In `src/modules/index.ts`, delete the line `import './pr-factory/slack-canvas.js';`.

## 3. Revert the delivery.ts reach-in

Reverse the three apply edits in `src/delivery.ts` byte-for-byte.

**3a.** Delete the hook infrastructure that was appended immediately after the `getDeliveryAction` function — this entire block (doc comment included):

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

**3b.** In `deliverMessage`, delete the transform application block — exactly these lines (the blank line above `const platformMsgId` is the context that follows it):

```typescript
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

```

**3c.** Change the now-mutable `files` declaration back to `const`, and pass `msg.content` again in the `deliver` call. The block becomes exactly:

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

## 4. Slack app scopes

Optionally remove `canvases:write` and `files:read` from the worker app's OAuth scopes (and reinstall the app). Existing canvases are workspace content — they persist independently of this component.

## 5. Restart and validate

> **Skip this step during full-recipe removal.** slack-canvas comes out first in the reverse order, but the rest of the stack is still present and the recipe-level validation is the binding one — run this block only when removing `slack-canvas` in isolation.

```bash
launchctl kickstart -k gui/$(id -u)/com.nanoclaw   # macOS
# systemctl --user restart nanoclaw                # Linux
pnpm run build && pnpm test
```

All green, with the file-transform test gone from the run.
