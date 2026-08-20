# Remove Ollama Tool

Idempotent — safe to run even if some steps were never applied. There are no
trunk-source edits to revert: the skill installs one file into the container
tree and one MCP entry per group.

## 1. Unregister the server from every group that has it

```bash
ncl groups list
ncl groups config get --id <group-id>      # look for an `ollama` MCP server
ncl groups config remove-mcp-server --id <group-id> --name ollama
```

Approval-gated, like the registration. Repeat for each group.

## 2. Restart the groups you unregistered

MCP servers are read at spawn, so a running container keeps its tools until it
is replaced:

```bash
ncl groups restart --id <group-id>
```

## 3. Delete the installed files

```bash
rm -f container/agent-runner/src/ollama-mcp-stdio.ts \
      container/agent-runner/src/ollama-mcp-stdio.test.ts
```

No image rebuild is needed — the file was mounted, not baked in. Confirm the
trees are clean:

```bash
pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit
```

`.claude/skills/add-ollama-tool/ollama-install.test.ts` asserts the applied
state, so `pnpm run test:skills` is expected to fail for this skill after
removal. That is the same contract every `/add-*` guard test has on a checkout
where the skill is not applied.

## 4. Nothing else was touched

Earlier versions of this skill patched `container/agent-runner/src/index.ts`,
`src/container-runner.ts`, `src/drivers/docker-driver.ts`, and `.env.example`,
and shipped `src/ollama-env.ts`. If you are removing one of those installs, also
revert those edits and delete `src/ollama-env.ts`, `src/ollama-wiring.test.ts`,
and `container/agent-runner/src/ollama-registration.test.ts`.

## Verification

```bash
ncl groups config get --id <group-id> | grep -i ollama || echo "no ollama server"
ls container/agent-runner/src/ollama-mcp-stdio.ts 2>/dev/null || echo "file removed"
```

Then ask a restarted agent to list Ollama models: it should report that it has
no such tool.
