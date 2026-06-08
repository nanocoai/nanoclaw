---
name: add-gemini
description: Use Google Gemini CLI as the agent provider — planning, tool orchestration, native compaction, MCP tools, session resume. Requires GEMINI_API_KEY. Per-group via agent_provider.
---

# Gemini agent provider

NanoClaw runs agents in a long-lived **poll loop** inside the container. The backend is selected with **`AGENT_PROVIDER`** (`claude` | `opencode` | `codex` | `gemini` | `mock`).

Trunk ships with only the `claude` provider baked in. This skill copies the Gemini provider files in from the `providers` branch (or your local fork), wires them into the host and container barrels, updates the Dockerfile to install the Gemini CLI, and rebuilds the image.

The Gemini provider runs `gemini app-server` as a child process and speaks JSON-RPC over stdio. This gives it native session resume, streaming events, and MCP tool access.

## Install

### Pre-flight

If all of the following are already present, skip to **Configuration**:

- `src/providers/gemini.ts`
- `container/agent-runner/src/providers/gemini.ts`
- `container/agent-runner/src/providers/gemini-app-server.ts`
- `container/agent-runner/src/providers/gemini.factory.test.ts`
- `import './gemini.js';` line in `src/providers/index.ts`
- `import './gemini.js';` line in `container/agent-runner/src/providers/index.ts`
- `ARG GEMINI_CLI_VERSION` and `"@google/gemini-cli@${GEMINI_CLI_VERSION}"` in `container/Dockerfile`

Missing pieces — continue below. All steps are idempotent.

### 1. Fetch the providers branch (if not in a fork)

```bash
git fetch upstream providers
```

### 2. Copy the Gemini source files

Wholesale copies (owned entirely by this skill):

```bash
git show upstream/providers:src/providers/gemini.ts                                      > src/providers/gemini.ts
git show upstream/providers:container/agent-runner/src/providers/gemini.ts               > container/agent-runner/src/providers/gemini.ts
git show upstream/providers:container/agent-runner/src/providers/gemini-app-server.ts    > container/agent-runner/src/providers/gemini-app-server.ts
git show upstream/providers:container/agent-runner/src/providers/gemini.factory.test.ts  > container/agent-runner/src/providers/gemini.factory.test.ts
```

### 3. Append the self-registration imports

`src/providers/index.ts`:

```typescript
import './gemini.js';
```

`container/agent-runner/src/providers/index.ts`:

```typescript
import './gemini.js';
```

### 4. Add the Gemini CLI to the container Dockerfile

Two edits to `container/Dockerfile`:

**(a)** In the "Pin CLI versions" ARG block:

```dockerfile
ARG GEMINI_CLI_VERSION=0.34.0
```

**(b)** Add a new standalone `RUN` block for the Gemini CLI:

```dockerfile
RUN --mount=type=cache,target=/root/.cache/pnpm \
    pnpm install -g "@google/gemini-cli@${GEMINI_CLI_VERSION}"
```

### 5. Build

```bash
pnpm run build                                         # host
./container/build.sh                                   # agent image
```

## Configuration

Gemini primarily uses an API key from Google AI Studio.

### Authentication

Add your API key to your `.env` file:

```env
GEMINI_API_KEY=AIza...
```

The host forwards this variable into the container.

### Per group / per session

Set `"provider": "gemini"` in the group's **`container.json`** (`groups/<folder>/container.json`).

## Verify

```bash
grep -q "./gemini.js" container/agent-runner/src/providers/index.ts && echo "container barrel: OK"
grep -q "./gemini.js" src/providers/index.ts && echo "host barrel: OK"
grep -q "@google/gemini-cli@" container/Dockerfile && echo "Dockerfile install: OK"
cd container/agent-runner && bun test src/providers/gemini.factory.test.ts && cd -
```

After the image rebuild, set `agent_provider = 'gemini'` on a test group and send a message.
