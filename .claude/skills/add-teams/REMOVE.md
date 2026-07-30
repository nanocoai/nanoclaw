# Remove Microsoft Teams

Every step is idempotent — safe to re-run.

## 1. Remove the adapter

Delete the self-registration import from `src/channels/index.ts` (skip if already gone):

```typescript
import './teams.js';
```

Then delete the copied adapter and its registration test:

```bash
rm -f src/channels/teams.ts src/channels/teams-registration.test.ts
```

## 2. Remove credentials

Remove `TEAMS_APP_ID`, `TEAMS_APP_PASSWORD`, `TEAMS_APP_TENANT_ID`, and `TEAMS_APP_TYPE` from `.env`.

## 3. Sign out the Teams CLI, then remove the packages

`teams login` caches a Microsoft 365 session on disk that outlives the package —
sign out first (skip if the CLI was never installed):

```bash
teams logout
npm uninstall -g @microsoft/teams.cli
pnpm uninstall @chat-adapter/teams
```

## 4. Remove local artifacts

```bash
rm -rf data/teams
```

## 5. Clean up cloud resources

Uninstall the app from Teams (Apps > Manage your apps). Then, on **both**
paths, delete the Entra app registration in Azure Portal > App registrations —
that is the step that actually revokes the client secret. Additionally:

- **Teams CLI path**: delete the app listing in the Teams Developer Portal
  (https://dev.teams.microsoft.com/apps) — removing it there alone does NOT
  revoke the secret.
- **Manual Azure path**: delete the Azure Bot resource, and the `nanoclaw-rg`
  resource group if you created one (`az group delete --name nanoclaw-rg`).

## 6. Rebuild and restart

```bash
pnpm run build
source setup/lib/install-slug.sh
launchctl kickstart -k gui/$(id -u)/$(launchd_label)  # macOS
# Linux: systemctl --user restart $(systemd_unit)
```
