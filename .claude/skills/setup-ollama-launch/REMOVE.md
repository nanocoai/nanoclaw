# Remove Ollama launch integration

Remove the launch-owned model mappings created by this skill:

```bash
rm -rf data/provider-state/ollama
```

Use `/add-local-web-chat/REMOVE.md` and `/add-ollama-provider/REMOVE.md`
separately to remove the capabilities installed by the launcher.

The launcher stamps `cli_scope=global` on the local agent group. If you keep
the group but no longer want that scope, reset it with
`ncl groups config update --id <agent-group-id> --cli-scope group`.
