# NanoClaw household operations

## Service layout and gates

This host cannot start a per-user systemd manager: `user@995.service` fails
while allocating its manager because user cgroup controllers are unavailable.
The owner-only unit files therefore live at the plan's paths under
`/var/lib/nanoclaw-household/.config/systemd/user/` and are linked into the
system manager. Both run with `User=nanoclaw`, `Group=nanoclaw`,
`NoNewPrivileges=true`, a read-only system view, and an explicit writable
state root.

- `nanoclaw-playbox.service`: development only, playbox enabled,
  `/var/lib/nanoclaw-household/state/playbox`, egress lockdown off.
- `nanoclaw.service`: production only, no playbox environment,
  `/var/lib/nanoclaw-household/state/production`, egress lockdown on.

Never run both. They have separate state, but would compete for Docker agent
names and the same household integration. Both are currently not enabled and
are blocked by:

```text
/var/lib/nanoclaw-household/.config/nanoclaw/onecli-ready
```

Task 8 must verify the OneCLI gateway, model credential, scoped staging ND
Expense credential, injection, and lockdown before root creates that empty
owner-only readiness sentinel. The sentinel is evidence of the completed gate,
not a substitute for it. Remove it immediately on OneCLI revocation or failure.

After the gate, enable exactly one unit:

```bash
systemctl disable --now nanoclaw.service nanoclaw-playbox.service
systemctl enable --now nanoclaw-playbox.service
# Later, after the dedicated WhatsApp rollout gate:
systemctl disable --now nanoclaw-playbox.service
systemctl enable --now nanoclaw.service
```

Real WhatsApp pairing and production activation remain deferred.

## Routine health checks

```bash
systemctl status nanoclaw-playbox.service --no-pager
journalctl -u nanoclaw-playbox.service -n 200 --no-pager
systemctl show nanoclaw-playbox.service -p NRestarts -p ActiveEnterTimestamp
docker ps --filter 'name=nanoclaw-' --format '{{.ID}} {{.Names}} {{.Status}}'
ss -ltnp | rg '127\.0\.0\.1:3210'
curl --fail --silent http://127.0.0.1:3210/ >/dev/null
df -h /var/lib/nanoclaw-household /srv/nanoclaw-household
```

For production, substitute `nanoclaw.service`. Port 3210 must have no
listener in production:

```bash
! ss -ltn | rg -q ':3210'
```

Inspect the central queue/session inventory without printing message bodies:

```bash
STATE_ROOT=/var/lib/nanoclaw-household/state/playbox
sqlite3 -readonly "$STATE_ROOT/data/v2.db" \
  "select status, container_status, count(*) from sessions group by status, container_status;"
find "$STATE_ROOT/data/v2-sessions" -name inbound.db -type f -exec \
  sqlite3 -readonly {} "select status,count(*) from messages_in group by status;" \;
journalctl -u nanoclaw-playbox.service --since '-15 min' --no-pager | \
  rg 'delivery failed|wakeContainer failed|retry|backlog'
```

Do not select `content` from session databases in routine diagnostics.

After the staging Worker is deployed, its public health check is:

```bash
curl --fail --silent \
  https://ndexpense-api-staging.smartecom.workers.dev/v1/health
```

D1 integrity and authenticated agent checks use the backend runbook at
`/home/ndexpense/.config/superpowers/worktrees/ndexpense/agent-workflow/docs/runbooks/receipt-agent-backend.md`.
Those remote commands remain deferred. OneCLI readiness checks must include the
pinned CLI/gateway versions, gateway container health, a permitted OpenRouter
call, permitted staging ND Expense call, and denied arbitrary/production hosts.

For a local synthetic text intake, keep NanoClaw stopped and run:

```bash
cd /srv/nanoclaw-household
bun scripts/verify-expense-agent.ts --local-double \
  --base-url http://127.0.0.1:3210 \
  --report /tmp/expense-agent-playbox-report.json
```

Once Task 8 is complete, use the browser playbox or its `/api/messages`
endpoint with only synthetic data and confirm the result through the staging
app/API. Never put credentials in curl arguments.

## Alert thresholds

Page the operator when any of these occur:

- repeated service restarts (`NRestarts >= 3` in 15 minutes);
- any pending delivery or inbound work older than five minutes;
- three consecutive provider, OneCLI, or ND Expense API failures;
- filesystem usage above 85%;
- production unexpectedly listening on port 3210;
- OneCLI readiness sentinel present while its gateway/credential checks fail.

Stop the active unit if retrying could amplify duplicate messages, uncontrolled
spend, or writes during a backend incident. Backend source keys make retries
idempotent, but that does not justify an unbounded retry loop.

## Upgrade backup

Only back up the inactive, stopped state. Choose the literal state name
`playbox` or `production`; do not use an unresolved or empty variable.

```bash
systemctl stop nanoclaw-playbox.service
install -d -o nanoclaw -g nanoclaw -m 0700 \
  /var/lib/nanoclaw-household/backups
git -C /srv/nanoclaw-household status --short
git -C /srv/nanoclaw-household rev-parse HEAD
tar --numeric-owner -C /var/lib/nanoclaw-household/state -czf \
  /var/lib/nanoclaw-household/backups/playbox-YYYYMMDDTHHMMSSZ.tgz \
  playbox
chmod 0600 /var/lib/nanoclaw-household/backups/playbox-YYYYMMDDTHHMMSSZ.tgz
```

Record the archive, Git commit, NanoClaw version, migration state, UTC time,
operator, and intended rollback commit together. NanoClaw state does not
contain OneCLI vault values; never add `.env`, `~/.onecli`, a OneCLI export,
or captured token output to the archive.

After an upgrade, rebuild and verify before enabling:

```bash
cd /srv/nanoclaw-household
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck
bun test scripts/verify-expense-agent.test.ts
bun scripts/verify-expense-agent.ts --local-double \
  --base-url http://127.0.0.1:3210 \
  --report /tmp/expense-agent-playbox-report.json
```

Then start the chosen unit and run one synthetic intake.

## Rollback

1. Stop the applicable unit and record its failing commit.
2. Confirm the worktree is clean; do not discard operator changes.
3. Switch to the recorded stable commit and rebuild its pinned dependencies.
4. Restore state only if a migration actually ran and only from the archive
   recorded for that exact commit.
5. Start the same unit, verify health, and rerun local plus live synthetic
   acceptance as available.

For a state restore, preserve the failed state for investigation rather than
overwriting it:

```bash
systemctl stop nanoclaw-playbox.service
mv /var/lib/nanoclaw-household/state/playbox \
  /var/lib/nanoclaw-household/state/playbox.failed-YYYYMMDDTHHMMSSZ
tar -C /var/lib/nanoclaw-household/state -xzf \
  /var/lib/nanoclaw-household/backups/playbox-YYYYMMDDTHHMMSSZ.tgz
chown -R nanoclaw:nanoclaw /var/lib/nanoclaw-household/state/playbox
chmod 0700 /var/lib/nanoclaw-household/state/playbox
```

Do not restore state merely for an application-code failure. Cloudflare Worker
and D1 rollback are separate procedures in the backend runbook and require
their own explicit authorization.
