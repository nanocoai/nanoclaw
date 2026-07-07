# Remove Native Credential Proxy

Reverts to the OneCLI gateway as the sole credential source. Idempotent — safe to run even if some steps were never applied.

## 1. Delete the copied files

```bash
rm -f src/native-credential-proxy.ts \
      src/native-credential-proxy.test.ts \
      src/native-credential-proxy-wiring.test.ts
```

## 2. Revert the reach-in in `src/container-runner.ts`

- Remove the import line:

  ```ts
  import { nativeCredentialEnvArgs } from './native-credential-proxy.js';
  ```

- Remove the call that follows the `TZ` env line, leaving the `TZ` line intact:

  ```ts
  args.push(...nativeCredentialEnvArgs());
  ```

## 3. Remove the env keys

Remove the native-credential block from `.env.example`, and from `.env` strip the opt-out flag and any credential the skill added:

```bash
for f in .env .env.example; do
  [ -f "$f" ] || continue
  sed -i.bak '/^NANOCLAW_NATIVE_CREDENTIALS=/d' "$f" && rm -f "$f.bak"
done
```

> Leave `ANTHROPIC_API_KEY` / `CLAUDE_CODE_OAUTH_TOKEN` / `ANTHROPIC_BASE_URL` in place if OneCLI or another tool still uses them; delete them from `.env` only if you no longer want `.env`-based credentials at all.

## 4. Rebuild and restart

Run from your NanoClaw project root:

```bash
pnpm run build
source setup/lib/install-slug.sh

# macOS
launchctl kickstart -k gui/$(id -u)/$(launchd_label)

# Linux
systemctl --user restart $(systemd_unit)
```

After removal, the OneCLI gateway is again the only credential path. If OneCLI is not yet configured, run `/init-onecli` (or `/setup`) to set up the agent vault.

## Verification

Confirm the reach-in is gone and the proxy file is removed:

```bash
test -f src/native-credential-proxy.ts && echo "still present" || echo removed
grep -c 'nativeCredentialEnvArgs' src/container-runner.ts
```

Expected: `removed`, and a count of `0`.
