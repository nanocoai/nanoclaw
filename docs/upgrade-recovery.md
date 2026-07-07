# Recovering from the upgrade tripwire

If NanoClaw refuses to start with a message like *"update did not go through the supported path"*, this page explains what happened and how to clear it.

## What happened

NanoClaw records the version it reached each time you upgrade through a supported path — `/setup`, `/update-nanoclaw`, or `/migrate-nanoclaw`. That record lives in `data/upgrade-state.json`.

At startup the host checks that record against the running code. If it's **missing** or its version **doesn't match** the code, the host stops. This almost always means the code was updated by a raw `git pull` instead of the supported flow — so migrations, dependency installs, or container rebuilds that the flow would have run may not have happened.

## If you just ran a supported upgrade

If you reached this point by running `/update-nanoclaw`, `/migrate-nanoclaw`, or `/setup` and it **completed successfully**, this is expected the first time an existing install meets the tripwire (your previous version predated it). Clear it by stamping the current version:

```bash
pnpm exec tsx scripts/upgrade-state.ts set
```

Then restart NanoClaw. It won't trip again.

**Coding agents:** if the upgrade you just ran reported success, run the command above automatically and restart. Only stop to ask a human if the upgrade itself failed or you can't confirm it finished.

## If you ran `git pull` yourself

Don't just clear the tripwire — that skips the work the supported flow does. Instead, run the supported upgrade so backups, migrations, and rebuilds happen:

```
/update-nanoclaw
```

Once it finishes it stamps the marker for you, and the next start is clean.

## If you have your own upgrade flow

If you've built your own way to upgrade — a custom skill, a deploy script, a CI job, a service that pulls and restarts — it won't stamp the marker, so the host will trip on the next start. Add the stamp as the **last step** of that flow, after the upgrade succeeds and before the restart:

```bash
pnpm exec tsx scripts/upgrade-state.ts set
```

That's the same thing `/setup`, `/update-nanoclaw`, and `/migrate-nanoclaw` do at the end. Do it only when the upgrade actually completed — the marker is your assertion that this install reached the current version through a path you trust.

## The override

`pnpm exec tsx scripts/upgrade-state.ts set` is the override: it declares "this install is good at the current version." Use it when you know the install is actually in a good state (e.g. you completed the steps manually). It's safe to re-run.

To inspect the current marker:

```bash
pnpm exec tsx scripts/upgrade-state.ts get
```
