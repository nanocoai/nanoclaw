# Remove Vercel

Every step is idempotent — safe to re-run. Steps delete the files and config the apply created.

## 1. Remove the container skill

```bash
rm -rf container/skills/vercel-cli
```

That is the whole removal for existing groups too. Each group's
`.claude-shared/skills/vercel-cli` is a symlink into the read-only `/app/skills`
mount, and `syncSkillSymlinks` (`src/container-runner.ts`) prunes symlinks that
are no longer in the group's selection on the next spawn.

Two leftovers to clear, both no-ops on a normal install:

```bash
# a) A real directory here means an older version of this skill rsync'd the
#    shared skills in. It shadows the mount, so it will not be pruned. Only the
#    vercel-cli name — do not widen the glob; template-stamped skills are also
#    real directories at this path and are meant to stay.
for d in data/v2-sessions/*/.claude-shared/skills/vercel-cli; do
  [ -d "$d" ] && [ ! -L "$d" ] && rm -rf "$d" && echo "removed stale copy: $d"
done

# b) Groups with an explicit skills list (not "all") name vercel-cli in it.
pnpm exec tsx scripts/q.ts data/v2.db \
  "UPDATE container_configs
      SET skills = (SELECT json_group_array(value) FROM json_each(skills) WHERE value <> 'vercel-cli')
    WHERE skills <> '\"all\"'
      AND EXISTS (SELECT 1 FROM json_each(skills) WHERE value = 'vercel-cli')"
```

## 2. Remove the dependency guard test

```bash
rm -f src/vercel-manifest.test.ts
```

## 3. Remove the OneCLI credential

Delete the Vercel secret, and strip its id from the assigned list of any agent
in `selective` mode. Agents in `all` mode have no assigned list to edit — the
secret's deletion is enough for them. `set-secrets` replaces the whole list, so
read, filter, and write back per selective agent; the filter runs in `jq`
because the assigned list may come back as ids or as objects.

```bash
VERCEL_SECRET_ID=$(onecli secrets list | jq -r '.data[] | select(.name | test("(?i)vercel")) | .id' | head -1)
if [ -n "$VERCEL_SECRET_ID" ]; then
  for agent in $(onecli agents list | jq -r '.data[] | select(.secretMode != "all") | .id'); do
    REMAINING=$(onecli agents secrets --id "$agent" \
      | jq -r --arg id "$VERCEL_SECRET_ID" \
          '[(.data[]? | if type == "object" then .id else . end) | select(. != $id)] | join(",")')
    # An empty list is a legitimate result (that agent had only this secret),
    # but onecli rejects an empty --secret-ids, so clear via secret mode
    # instead of sending nothing.
    if [ -n "$REMAINING" ]; then
      onecli agents set-secrets --id "$agent" --secret-ids "$REMAINING" \
        || { echo "FAILED: could not rewrite assigned secrets for $agent"; exit 1; }
    else
      echo "NOTE: $agent had only the Vercel secret assigned; deleting the secret below clears it."
    fi
  done
  onecli secrets delete --id "$VERCEL_SECRET_ID"
fi
```

## 4. The Vercel CLI in the container image

Remove the `vercel` entry from `container/cli-tools.json` — this skill added it, and it is
not part of the base image. Then make the image match the manifest. **Which
command does that depends on how this install gets its image**, because a bare
rebuild cannot subtract:

```bash
grep -q '^NANOCLAW_HARDENED_IMAGE=true' .env && echo PULLED || echo SELF_BUILT
```

- **SELF_BUILT** — `./container/build.sh` rebuilds from the Dockerfile and installs only what the manifest now lists, so `vercel` is gone.
- **PULLED** — `./container/build.sh` takes the *overlay* path: one layer `FROM` the tag that already exists, re-applying the manifest. Removing an entry removes nothing; the binary is in a layer underneath and the probe below will say `STILL PRESENT`. Re-fetch the published image instead, which replaces the local tag and drops the overlay with it:

  ```bash
  ./container/build.sh pull
  ```

  (`./container/build.sh build` also works, but it is a different decision: it
  builds from the base *and* flips `NANOCLAW_HARDENED_IMAGE` to false, taking
  the install off the pulled-image path for good. Only do that if the operator
  asks for it.)

Confirm the binary is gone (a stale image is the mirror image of the apply-side
trap — manifest clean, binary still there):

```bash
. setup/lib/install-slug.sh
docker run --rm --entrypoint sh "$(container_image_base):latest" -c 'command -v vercel' \
  && echo "STILL PRESENT — rebuild did not take" || echo "REMOVED"
```

(`sh -c`, not `sh -lc` — a login shell re-reads `/etc/profile` and drops
`/pnpm` from `PATH`, which makes every global CLI look absent.)

## 5. Restart running containers

So sessions stop loading the removed `vercel-cli` skill on next wake:

```bash
for id in $(pnpm exec tsx scripts/q.ts data/v2.db "SELECT id FROM agent_groups"); do
  ncl groups restart --id "$id"
done
```

If `ncl` is unavailable, stop the containers directly — scoped to **this
install's slug**, so peer installs on the same host are untouched:

```bash
. setup/lib/install-slug.sh
SLUG="$(container_image_base)"; SLUG="${SLUG##*-}"
docker ps --filter "label=nanoclaw-install=$SLUG" --filter "label=nanoclaw-role=agent" -q \
  | xargs -r docker stop
```
