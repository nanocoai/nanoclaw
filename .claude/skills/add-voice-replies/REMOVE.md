# Remove Voice Replies

Safe to run even if some steps were never applied.

## 1. Unregister the server from each group

Find the groups that have it:

```bash
ncl groups list
ncl groups config get --id <group-id>
```

For each group with a `voice` MCP server:

```bash
ncl groups config remove-mcp-server --id <group-id> --name voice
```

If the group got `espeak-ng` for this skill and nothing else uses it, remove
the package too:

```bash
ncl groups config remove-package --id <group-id> --apt espeak-ng
```

## 2. Delete the copied files

```bash
rm -f container/agent-runner/src/tts/types.ts \
      container/agent-runner/src/tts/registry.ts \
      container/agent-runner/src/tts/http.ts \
      container/agent-runner/src/tts/espeak.ts \
      container/agent-runner/src/tts/openai-compatible.ts \
      container/agent-runner/src/tts/elevenlabs.ts \
      container/agent-runner/src/tts/index.ts \
      container/agent-runner/src/tts/server.ts \
      container/agent-runner/src/tts/tts-registration.test.ts \
      container/agent-runner/src/tts/voice-server.test.ts
rmdir container/agent-runner/src/tts 2>/dev/null || true
```

## 3. Remove stored credentials (optional)

If a key was stored in the credential gateway for `api.elevenlabs.io` or
`api.openai.com` only for this skill, delete it through the gateway's own
console or CLI.

## 4. Restart

Restart each affected group. Add `--rebuild` if a package was removed:

```bash
ncl groups restart --id <group-id> --rebuild
```

## Verification

```bash
test -d container/agent-runner/src/tts && echo "still present" || echo "removed"
```

`ncl groups config get --id <group-id>` should show no `voice` server.
