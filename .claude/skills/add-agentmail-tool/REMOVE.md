# Remove AgentMail Tool

Every step is idempotent, so it is safe to re-run.

## 1. Remove the container skill

```bash
rm -rf container/skills/agentmail
```

## 2. Remove each group's email setup

For each group that was set up (`ls -d groups/*/email`):

- Delete the `## Email` block that apply appended to `groups/<folder>/instructions.prepend.md`
  (the heading and the one line under it naming the inbox).
- The `groups/<folder>/email/` folder holds the agent's email memory: the
  thread ledger, the send log, and its policy and contacts. Ask the operator
  before deleting it. To remove it:

  ```bash
  rm -rf groups/<folder>/email groups/<folder>/inbox-mail
  ```

- If the agent created an email watcher task, cancel it: `ncl tasks list --group <group-id>`
  shows it (its script is `/app/skills/agentmail/mail gate`), then `ncl tasks delete <task-id>`.

## 3. Remove the gateway credential

Skip this if anything else on the install still calls `api.agentmail.to` through
the gateway. (The AgentMail channel reads its own key from `.env` and is unaffected.)

- **OneCLI**: `onecli secrets list`, find the `AgentMail` entry for
  `api.agentmail.to`, then `onecli secrets delete --id <id>`.
- **Iron Proxy**: delete the `AgentMail` secret in the Iron Control console
  (**Secrets**) and revoke its grant to this install.

## 4. Restart the groups

```bash
ncl groups restart --id <group-id>
```
