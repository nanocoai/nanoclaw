# Remove Gmail Tool

Idempotent — safe to run even if some steps were never applied.

## 1. Delete the copied tests

```bash
rm -f container/agent-runner/src/providers/gmail-dockerfile.test.ts \
      container/agent-runner/src/providers/gmail-allow-pattern.test.ts
```

## 2. Unregister the MCP server (per group)

`ncl groups list` shows the groups. For each group that had Gmail wired:

```bash
ncl groups config remove-mcp-server --id <group-id> --name gmail
```

## 3. Remove the `.gmail-mcp` mount (per group)

There is no `ncl groups config remove-mount` verb yet ([#2395](https://github.com/nanocoai/nanoclaw/issues/2395)). Edit the central DB via the in-tree wrapper (`scripts/q.ts` — NanoClaw avoids depending on the `sqlite3` CLI, `setup/verify.ts:5`). Run from your NanoClaw project root (where `data/v2.db` lives):

```bash
GROUP_ID='<group-id>'
pnpm exec tsx scripts/q.ts data/v2.db "UPDATE container_configs \
  SET additional_mounts = (SELECT json_group_array(value) FROM json_each(additional_mounts) \
                           WHERE json_extract(value, '\$.containerPath') != '.gmail-mcp'), \
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') \
  WHERE agent_group_id = '$GROUP_ID';"
```

## 4. Remove the Dockerfile install

In `container/Dockerfile`, delete the `ARG GMAIL_MCP_VERSION=...` line and the `pnpm install -g` `RUN` block that installs `@gongrzhe/server-gmail-autoauth-mcp` and `zod-to-json-schema`.

## 5. Rebuild and restart

Run from your NanoClaw project root:

```bash
pnpm run build && ./container/build.sh
source setup/lib/install-slug.sh

# macOS
launchctl kickstart -k gui/$(id -u)/$(launchd_label)

# Linux
systemctl --user restart $(systemd_unit)
```

## 6. (Optional) Drop the host stubs and disconnect

```bash
rm -rf ~/.gmail-mcp/                          # only if no other host tool needs the stubs
onecli apps disconnect --provider gmail       # revoke the OneCLI Gmail connection
```
