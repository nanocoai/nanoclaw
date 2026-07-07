# Remove Emacs

Every step is idempotent — safe to re-run.

## 1. Remove the adapter

Delete the self-registration import from `src/channels/index.ts` (skip if already gone):

```typescript
import './emacs.js';
```

Then delete the copied adapter, its tests, and the Lisp client:

```bash
rm -f src/channels/emacs.ts src/channels/emacs.test.ts src/channels/emacs-registration.test.ts emacs/nanoclaw.el
```

## 2. Remove credentials

Remove the `EMACS_*` lines from `.env`:

```bash
EMACS_ENABLED
EMACS_CHANNEL_PORT
EMACS_AUTH_TOKEN
EMACS_PLATFORM_ID
```

## 3. Rebuild and restart

Run from your NanoClaw project root:

```bash
pnpm run build
source setup/lib/install-slug.sh

# Linux
systemctl --user restart $(systemd_unit)

# macOS
launchctl kickstart -k gui/$(id -u)/$(launchd_label)
```

## 4. Remove the Emacs config (optional)

Remove the NanoClaw block from your Emacs config (`config.el`, `~/.spacemacs`, or `init.el`):

```elisp
;; NanoClaw — personal AI assistant channel
(load-file "~/src/nanoclaw/emacs/nanoclaw.el")
;; ...and the associated keybindings / nanoclaw-auth-token / nanoclaw-port settings
```

Reload your config or restart Emacs.

## 5. Remove the messaging group (optional)

To clean up the wired messaging group:

```bash
pnpm exec tsx scripts/q.ts data/v2.db "DELETE FROM messaging_group_agents WHERE messaging_group_id IN (SELECT id FROM messaging_groups WHERE channel_type='emacs'); DELETE FROM messaging_groups WHERE channel_type='emacs';"
```
