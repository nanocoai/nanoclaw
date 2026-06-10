# Remove Tool Visibility

Idempotent — safe to run even if some steps were never applied. Reverses the
copied hook module, both tests, and the provider wiring.

## 1. Delete the copied files

```bash
rm -f container/agent-runner/src/hooks/tool-visibility.ts
rm -f container/agent-runner/src/hooks/tool-visibility.test.ts
rm -f container/agent-runner/src/hooks/tool-visibility-wiring.test.ts
rmdir container/agent-runner/src/hooks 2>/dev/null || true   # only if now empty
```

## 2. Revert the provider wiring

In `container/agent-runner/src/providers/claude.ts`:

- DELETE the import line
  `import { postToolUseVisibility, preToolUseVisibility } from '../hooks/tool-visibility.js';`
  (delete, don't comment out). Skip if already gone.
- In the `hooks:` options object inside `ClaudeProvider.query()`, remove the
  two visibility entries so the three arrays read:

```typescript
        hooks: {
          PreToolUse: [{ hooks: [preToolUseHook] }],
          PostToolUse: [{ hooks: [postToolUseHook] }],
          PostToolUseFailure: [{ hooks: [postToolUseHook] }],
          PreCompact: [{ hooks: [createPreCompactHook(this.assistantName)] }],
        },
```

Leave `PreCompact` and everything else untouched.

## 3. Dependencies

None to uninstall — the skill adds no packages; it uses the SDK and DB layer
the agent-runner already ships.

## 4. Rebuild and restart

Run from your NanoClaw project root:

```bash
pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit
cd container/agent-runner && bun test; cd ../..
./container/build.sh
source setup/lib/install-slug.sh
systemctl --user restart $(systemd_unit)              # Linux
# or: launchctl kickstart -k gui/$(id -u)/$(launchd_label)  # macOS
```

## Verification

Confirm it is fully unwired:

```bash
ls container/agent-runner/src/hooks/tool-visibility.ts 2>/dev/null   # no such file
grep -n "ToolUseVisibility" container/agent-runner/src/providers/claude.ts   # no output
```

New containers spawned after the restart no longer send tool-call previews.
