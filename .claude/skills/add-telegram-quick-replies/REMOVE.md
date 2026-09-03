# Remove Telegram Quick Replies

Idempotent — safe to run even if some steps were never applied.

## 1. Delete the copied files (both trees)

```bash
rm -f src/modules/telegram-keyboards/keyboard.ts \
      src/modules/telegram-keyboards/index.ts \
      src/modules/telegram-keyboards/index.test.ts \
      container/agent-runner/src/mcp-tools/telegram-keyboard.ts \
      container/agent-runner/src/mcp-tools/telegram-keyboard.test.ts \
      container/agent-runner/src/mcp-tools/telegram-keyboard.instructions.md
rmdir src/modules/telegram-keyboards 2>/dev/null || true
```

## 2. Unregister the host module

In `src/modules/index.ts`, delete the line:

```
import './telegram-keyboards/index.js';
```

## 3. Unregister the container tools

In `container/agent-runner/src/mcp-tools/index.ts`, delete the line:

```
import './telegram-keyboard.js';
```

## 4. Confirm

```bash
pnpm build && pnpm lint
```

The skill adds no dependency, no env key and no Dockerfile change, so nothing
else is left behind. Agents lose `send_quick_replies` and `clear_quick_replies`
at their next container spawn; `ask_user_question` is unaffected.
