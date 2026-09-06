# Community portal setup test

This branch adds browser entry points to the NanoClaw setup wizard. WorkOS
sign-in authenticates the portal and authorizes the waiting installation in
one flow. Echo and Slack use the real NanoClaw account services. Tavily and
Dial provide simulated credentials and a fictional phone number; they do not
create partner accounts, perform searches, or place calls.

Use a fresh VM with Docker, Node 22 and pnpm 10.34.5. Use the Claude provider
for this walkthrough because this version's prebuilt Echo image supports
Claude. Bring your normal provider login and a Slack workspace where you can
connect and install the managed app.

```sh
git clone --branch test/community-portal-e2e https://github.com/nanocoai/nanoclaw.git nanoclaw
cd nanoclaw
pnpm install --frozen-lockfile
export NANOCLAW_PORTAL_ORIGIN=https://portal.nanoclaw.dev
export NANOCLAW_AGENT_PROVIDER=claude
pnpm setup:auto
```

Keep the exported portal origin in the terminal session for subsequent setup
commands. This branch leaves the normal wizard unchanged when it is unset.
Clone normally, without `--single-branch`, so channel installation can fetch
its payload from the repository's `channels` branch.

At each relevant setup stage, the CLI checks whether the perk is enabled. If
it is not, it asks for consent and prints a browser link. Over SSH, open that
link on your laptop. Sign in, activate the perk in the dashboard modal, then
enable any others you want. Choose **Return to terminal** to release the
waiting setup. Later stages reuse already enabled perks.

After setup has delivered the test credentials, check them without printing
or copying their values:

```sh
pnpm exec tsx setup/portal-check.ts tavily
pnpm exec tsx setup/portal-check.ts dial
```

Each successful check consumes one simulated credit. The output explicitly
states that no live search or call occurred. The private installation journal
is `data/community-portal.json`; do not share or commit it.

To revisit a specific entry point:

```sh
pnpm exec tsx setup/portal.ts --stage echo
pnpm exec tsx setup/portal.ts --stage slack
pnpm exec tsx setup/portal.ts --stage tavily
pnpm exec tsx setup/portal.ts --stage dial
```

Run one setup command at a time per checkout. If interrupted normally, rerun
the same command to resume the saved request. An enabled perk skips the
browser prompt. Account-level activation persists across installations, so a
second VM does not reset the account's activation state.

For the walkthrough, verify an actual Echo image pull and an agent reply in
Slack. Partner activation alone does not establish those results. Production
partner integration and agent consumption of partner credentials are deferred.
