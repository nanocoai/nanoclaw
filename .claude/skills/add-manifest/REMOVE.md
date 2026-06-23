# Remove Manifest Provider

1. Remove the barrel import from `src/providers/index.ts`:
   Delete the line `import './manifest.js';`

2. Remove the barrel import from `container/agent-runner/src/providers/index.ts`:
   Delete the line `import './manifest.js';`

3. Remove the provider files:

```bash
rm src/providers/manifest.ts
rm container/agent-runner/src/providers/manifest.ts
```

4. Remove the test files:

```bash
rm src/providers/manifest-registration.test.ts
rm container/agent-runner/src/providers/manifest-registration.test.ts
rm container/agent-runner/src/providers/manifest.factory.test.ts
```

5. Remove `MANIFEST_BASE_URL` from `.env` if present.

6. Remove the OneCLI secret for the Manifest host:

```bash
onecli secret remove --host-pattern "YOUR_MANIFEST_HOST"
```

7. Rebuild:

```bash
pnpm run build
```
