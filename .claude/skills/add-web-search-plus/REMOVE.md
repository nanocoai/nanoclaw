# Remove Web Search Plus

Idempotent — safe to run even if some steps were never applied. Reverses the
copied container skill, the integration test, and the Dockerfile edit.

## 1. Delete the copied skill files and test

```bash
rm -rf container/skills/web-search-plus
rm -f src/wsp-skill.test.ts
```

## 2. Revert the Dockerfile edit

In `container/Dockerfile`, delete the `python3 \` line this skill added to the
system-deps `apt-get install` block (between `git \` and `tini \`). Skip if
already gone. Leave every other package line untouched.

## 3. Dependencies

The engine is pure-stdlib Python and `wsp` is a shell script — there is no npm
or bun package to uninstall. Step 2 removes the only dependency surface
(the apt `python3` install).

## 4. Per-group key files and cache

Remove the key file and cache from each group that configured a provider key,
unless another integration uses them:

```bash
rm -f groups/<folder>/.wsp.env
rm -rf groups/<folder>/.wsp-cache
```

If a provider key was stored in the OneCLI vault solely for wsp, delete that
secret in the OneCLI dashboard.

For any group with an explicit skills list in container config (not `"all"`),
remove `"web-search-plus"` from that list.

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

## Verification

After removal, the skill's guards no longer apply (their files are gone).
Confirm it is fully unwired:

```bash
ls container/skills/web-search-plus 2>/dev/null        # no such directory
grep -n "python3" container/Dockerfile                 # no output
ls src/wsp-skill.test.ts 2>/dev/null                   # no such file
```

New containers spawned after the restart no longer show `web-search-plus`
under `/app/skills/`.
