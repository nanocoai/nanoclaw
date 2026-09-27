# Remove OneCLI gateway

Use NanoClaw's journal-derived skill removal first. Then remove only the OneCLI agents whose identifiers match this NanoClaw install's agent-group IDs:

```bash
onecli agents list
onecli agents delete --id <matching-agent-uuid>
```

Do not remove the shared OneCLI application, vault, or credentials unless the operator asks for that separately. Select another installed gateway before restarting NanoClaw.
