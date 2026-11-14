# Remove Rapid-MLX

For each group where this skill registered `rapid_mlx`, inspect `ncl groups config get --id <group-id>`. If the entry exists, remove it and restart the group:

```bash
ncl groups config remove-mcp-server --id <group-id> --name rapid_mlx
ncl groups restart --id <group-id>
```

After unregistering every group, delete the copied files:

```bash
rm -f container/agent-runner/src/rapid-mlx-mcp-stdio.ts \
  container/agent-runner/src/rapid-mlx-mcp-stdio.test.ts
```

If optional authentication was configured through the credential gateway solely for this integration, remove that origin's credential using the gateway's credential workflow. Preserve credentials used by other integrations.

Confirm the group configs contain no `rapid_mlx` entry, unrelated MCP entries are unchanged, and both copied files are absent. Start another conversation after restarting and confirm the agents no longer expose its tools. A restart result of `restarted: 0` does not verify removal from a running agent; record that limitation if provider credentials or channel setup prevent the conversation. Repeating removal is safe: skip absent config entries; `rm -f` tolerates missing files. Remove this skill from the install's customization recipe.
