---
name: add-manifest
description: Add the Manifest model router as a provider
type: feature
---

# Add Manifest Provider

Manifest is a model router for AI agents. It scores each request by complexity
and routes it to the best model. It exposes an OpenAI-compatible endpoint at
`/v1/chat/completions`.

## Install

1. Fetch the provider files from the providers branch:

```bash
git fetch origin providers
git show origin/providers:src/providers/manifest.ts > src/providers/manifest.ts
git show origin/providers:container/agent-runner/src/providers/manifest.ts > container/agent-runner/src/providers/manifest.ts
```

2. Append the barrel imports:

```bash
echo "import './manifest.js';" >> src/providers/index.ts
```

In `container/agent-runner/src/providers/index.ts`, add before the mock import:

```typescript
import './manifest.js';
```

3. Set your Manifest endpoint in `.env`:

```
MANIFEST_BASE_URL=http://localhost:3001/v1
```

4. Register your Manifest API key as a OneCLI secret so the real key never
   enters the container:

```bash
onecli secret add \
  --host-pattern "localhost:3001" \
  --header-name Authorization \
  --value-format "Bearer {value}" \
  --value "mnfst_YOUR_KEY"
```

Replace `localhost:3001` with your Manifest instance hostname and
`mnfst_YOUR_KEY` with your actual API key.

5. Rebuild the container:

```bash
pnpm run build
```

6. Start a session with the manifest provider:

```bash
nanoclaw --provider manifest
```

The `auto` model is used by default. Manifest routes each request through its
scoring engine to the best available model.
