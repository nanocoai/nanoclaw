# Run NanoClaw with the community portal

Use a fresh exe.dev VM with Docker, Node 22, pnpm 10.34.5 and native build
prerequisites. Bring your normal agent-provider credentials and access to a
Slack workspace where you can connect and install the managed app. The VM
needs no AWS, Vercel, WorkOS server or Slack server credentials.

```sh
git clone --branch feat/community-portal https://github.com/nanocoai/nanoclaw.git nanoclaw
cd nanoclaw
pnpm install --frozen-lockfile
pnpm setup:auto
```

Clone normally, without `--single-branch` or a shallow clone: channel installation
fetches the repository's `channels` branch. Do not copy another installation's
`.env`, `node_modules`, account files or setup journal. The Echo prebuilt image
path currently supports the Claude provider. Fresh setup selects Claude
automatically. An existing provider choice or explicit `NANOCLAW_AGENT_PROVIDER`
override is honored.

The portal opens at **https://portal.nanoclaw.dev** by default. The CLI asks
before opening the browser and prints the link for SSH users to open on their
laptop. WorkOS login establishes the browser session and authorizes the
originating installation through its activation choice. No tunnel, callback
listener, separate CLI login or pairing code is required.

## Walkthrough

1. Start setup and consent to the Echo offer. After WorkOS login, the dashboard
   opens with its activation modal. Enable Echo, explore the other perks, and
   choose **Return to terminal**. Verify the container step actually pulls the
   pinned Echo image; saving the choice alone does not prove the pull.
2. Connect Slack through its OAuth flow in the portal. At the Slack setup step,
   select your workspace and return to the terminal. Complete any required
   installation approval, start NanoClaw, and get a reply in your Slack chat.
3. Already-enabled perks should be reused at subsequent setup stages. A skipped
   perk is offered again at its next applicable step. Tavily and Dial show
   **Coming soon** and are skipped by the CLI. No fake keys, credits, numbers,
   search results or calls are produced.
4. Interrupt and resume a setup step. It should reuse the pending request or
   saved Slack app rather than create duplicates. An ambiguous Slack create is
   held for recovery because the existing API has no idempotency contract.
5. Sign out of the browser. Account navigation should disappear immediately,
   including when the session expires. Signing the installation out from
   **Devices** should reject its old installation credential.

Revisit a step with `pnpm exec tsx setup/portal.ts --stage echo` or `--stage slack`,
one at a time. Private state is in `data/community-portal.json`; never share or
commit it. Keep that file when recovering an interrupted setup. Each checkout
retains its own installation identity.

The automated suite exercises the service, real cell, storage, CLI bridge and
browser UI. A completed WorkOS login, Echo image pull and real Slack reply on
your VM are the remaining operator acceptance checks. No VM or Slack app was
created by the preparation work.
