# Remove Mnemon

Every step is idempotent — safe to run even if some steps were never applied.

## 1. Unwire the runner startup call

Open `container/agent-runner/src/index.ts` and delete the import and the call:

```ts
import { ensureMnemonSetup } from './mnemon/setup.js';
```

```ts
  // add-mnemon: assert the graph-memory hooks in $HOME/.claude before the
  // provider is constructed, so the provider's own settings.json merge lands
  // after ours. Idempotent, never fatal. See mnemon/setup.ts for why this is
  // here and not in container/entrypoint.sh.
  ensureMnemonSetup(providerName);
```

Confirm nothing is left: `grep -rn ensureMnemonSetup container/agent-runner/src/index.ts` should print nothing.

Older installs (before the wiring moved onto the executed path) instead had a `mnemon setup --target claude-code --yes --global` line in `container/entrypoint.sh`, right after `set -e`. That line never ran — the host spawn path overrides the image entrypoint — but delete it if it is there:

```bash
grep -n 'mnemon setup' container/entrypoint.sh   # then remove any line it prints
```

## 2. Delete the setup module and its tests

```bash
rm -rf container/agent-runner/src/mnemon
rm -f src/mnemon-install.test.ts
# older installs only:
rm -f src/mnemon-dockerfile.test.ts src/mnemon-entrypoint.test.ts
```

Then drop the two `add-mnemon` entries from the exclusion list in `vitest.skills.config.ts` if they are there:

```
      '.claude/skills/add-mnemon/mnemon-setup.test.ts',
      '.claude/skills/add-mnemon/mnemon-startup.test.ts',
```

## 3. Strip the Dockerfile install layer

Open `container/Dockerfile` and delete the whole mnemon block — the `# ---- mnemon` comment, the `ARG MNEMON_VERSION` line, the `RUN` that installs `jq` and downloads the binary, and the `ENV MNEMON_DATA_DIR` line. It sits immediately above `# ---- ncl CLI wrapper` (older installs put it above `# ---- Bun runtime`).

Match on the ARG name rather than a version number — the pin moves (`0.1.1` in the first release of this skill, `0.2.4` now, whatever the pre-flight found on your install):

```bash
grep -n 'MNEMON\|mnemon-dev' container/Dockerfile   # then remove every line it prints, plus the comment block
```

Note the `RUN` also installs `jq`. Nothing else in the image needs it, so removing it with the block is correct — but if you have since come to rely on `jq` in agent containers, keep an `apt-get install jq` layer of your own.

## 4. Verify, rebuild, restart

```bash
pnpm run build
pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit
pnpm exec vitest run
(cd container/agent-runner && bun test)
./container/build.sh

source setup/lib/install-slug.sh
docker run --rm --entrypoint mnemon "$(container_image_base):latest" --version   # expect: executable file not found

# macOS
launchctl kickstart -k gui/$(id -u)/$(launchd_label)
# Linux
systemctl --user restart $(systemd_unit)
```

## 5. Un-register the hooks and delete stored memory (optional)

The hook scripts, the registered `settings.json` entries and the graph all live in each agent group's `.claude-shared` mount — host path `data/v2-sessions/<agent-group-id>/.claude-shared/` — so removing the binary from the image leaves them behind: `settings.json` keeps calling hooks that no longer exist.

Easiest order is to let mnemon un-register itself **before** step 4 rebuilds the image, from inside a container of each affected group (`--global` is required; without it mnemon ejects a project-local install and reports success while changing nothing user-wide):

```bash
docker exec "$CTR" mnemon setup --eject --target claude-code --yes --global
```

That removes `hooks/mnemon/`, `skills/mnemon/` and mnemon's `SessionStart` / `UserPromptSubmit` / `Stop` entries, and leaves NanoClaw's own `SessionStart` memory hook (`bun /app/src/memory/hook.ts`) intact. It does not delete the graph; with the containers stopped:

```bash
for d in data/v2-sessions/*/.claude-shared; do rm -rf "$d/mnemon"; done
```

If the image is already rebuilt (no binary left to eject with), do it by hand per group — delete `hooks/mnemon/`, `skills/mnemon/` and `mnemon/` under `.claude-shared/`, and edit each `settings.json` to drop the three hook entries whose commands point into `hooks/mnemon/`, keeping NanoClaw's own `SessionStart` entry.
