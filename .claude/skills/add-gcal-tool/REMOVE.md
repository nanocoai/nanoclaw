# Remove Google Calendar Tool

Idempotent — safe to run even if some steps were never applied.

## 1. Unregister the MCP server (per group)

For each group that had Calendar wired (`ncl groups list` to enumerate):

```bash
ncl groups config remove-mcp-server --id <group-id> --name calendar
```

## 2. Remove the `.calendar-mcp` mount from the DB (per group)

This is a **host-only / operator** verb — run it host-side. It's idempotent (a no-op if the mount is absent):

```bash
ncl groups config remove-mount \
  --id <group-id> \
  --host "$HOME/.calendar-mcp" \
  --container .calendar-mcp
```

## 3. Delete the copied test file

```bash
rm -f src/gcal-dockerfile.test.ts
```

## 4. Revert the Dockerfile edits

Remove the `ARG CALENDAR_MCP_VERSION=...` line and the `@cocal/google-calendar-mcp@${CALENDAR_MCP_VERSION}` entry from the pnpm global-install block in `container/Dockerfile`. If Calendar shared the gmail install block, leave the gmail entry intact; if it had a standalone `RUN ... pnpm install -g "@cocal/google-calendar-mcp@..."` block, delete that whole `RUN` line.

## 5. Rebuild and restart

```bash
pnpm run build && ./container/build.sh
source setup/lib/install-slug.sh

# macOS
launchctl kickstart -k gui/$(id -u)/$(launchd_label)

# Linux
systemctl --user restart $(systemd_unit)
```

Kill any running agent containers so they respawn without the `calendar` MCP server:

```bash
docker ps -q --filter 'name=nanoclaw-v2-' | xargs -r docker kill
```

## 6. Optional: remove stubs and disconnect OneCLI

```bash
rm -rf ~/.calendar-mcp/
onecli apps disconnect --provider google-calendar
```

## Verification

After removal, in a wired agent asking it to "list my calendars" should report no calendar tool, and the dependency-guard test is gone:

```bash
ls src/gcal-dockerfile.test.ts 2>&1   # No such file or directory
```
