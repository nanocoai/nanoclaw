# Household NanoClaw local installation

Installed on 2026-08-02 as the dedicated `nanoclaw` service account.

## Pinned baseline

- NanoClaw: `4446b5bde12613ec58289b5a9ac2f5dde947d7e3` (`2.1.54`)
- Branch: `household-expense-agent`
- Node.js: `v22.22.0`
- pnpm: `10.33.0` (from the checkout's `packageManager` field)
- Bun: `1.3.14`
- Docker Engine: `20.10.5+dfsg1`
- systemd: `247`

Source is installed at `/srv/nanoclaw-household`. Runtime state belongs under
`/var/lib/nanoclaw-household`. Both paths are owned by `nanoclaw:nanoclaw` with
mode `0750`, and lingering is enabled for the account's user services.

No WhatsApp adapter, pairing state, OpenRouter credential, or ND Expense
credential was installed during the baseline step.

## Baseline verification

From the checkout as `nanoclaw`:

```bash
pnpm test
pnpm typecheck
git status --short
```

The pinned checkout passed its host test suite and typecheck before household
customization began. Run pnpm commands from the checkout root so Corepack reads
NanoClaw's pnpm 10 pin rather than a parent project's package-manager setting.

## Installation note

Because `/srv` is root-owned, cloning as the service account requires the exact
target directory to exist and be owned by `nanoclaw`; clone into `.` from that
directory. Do not grant the service account write access to `/srv` itself.
