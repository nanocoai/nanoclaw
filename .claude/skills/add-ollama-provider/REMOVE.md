# Remove Ollama Provider

For each configured agent group:

1. Remove the `env` and `blockedHosts` keys from
   `groups/<FOLDER>/container.json`.
2. Remove the `model` key from
   `data/v2-sessions/<group-id>/.claude-shared/settings.json` while preserving
   every other setting.
3. Restart the group so the next container uses the default Claude route.

```bash
ncl groups restart --id <group-id>
```

No image rebuild is required.
