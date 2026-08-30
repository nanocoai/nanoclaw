# Remove Ollama provider

Remove the provider files and their barrel registrations:

```bash
rm -f \
  src/providers/ollama.ts \
  src/providers/ollama.test.ts \
  src/providers/ollama-registration.test.ts \
  container/agent-runner/src/providers/ollama.ts \
  container/agent-runner/src/providers/ollama-registration.test.ts \
  container/agent-runner/src/providers/ollama-tool-policy.test.ts \
  container/agent-runner/src/mcp-tools/ollama-web.ts \
  container/agent-runner/src/mcp-tools/ollama-web.test.ts
```

Delete `import './ollama.js';` from both `src/providers/index.ts` and
`container/agent-runner/src/providers/index.ts`, and delete
`import './ollama-web.js';` from
`container/agent-runner/src/mcp-tools/index.ts`, then run:

```bash
pnpm run build
pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit
```

If the configure step set them, remove `OLLAMA_BASE_URL` and
`OLLAMA_WEB_BROWSING` from `.env`.

Before restarting a group that used Ollama, select another installed provider.
