---
name: add-ynab-tool
description: Give an agent group access to YNAB (You Need A Budget) via direct REST API calls. The agent uses Bash + curl against `https://api.ynab.com/v1/*`; OneCLI rewrites the outbound `Authorization` header at request time so no raw Personal Access Token ever reaches the container. No MCP server, no Dockerfile changes — just CLAUDE.md instructions and one OneCLI secret.
---

# Add YNAB Tool (curl + OneCLI)

This skill teaches an agent group how to use the YNAB REST API directly. It does **not** install an MCP server. Why: the published `ynab-mcp-server@0.1.2` (latest as of writing) uses the deprecated `mcp-framework` package whose response format newer claude-code MCP clients reject, and only ships 5 of the 17 tools the maintainer has written on git main (unreleased since November 2025). Direct curl is more reliable, more flexible, and the agent — which already has `Bash` — needs no new capability to use it.

The pattern: agent reads the API token as the literal placeholder string `onecli-managed`, hits `https://api.ynab.com/v1/...` with `Authorization: Bearer onecli-managed`, and OneCLI swaps the header in flight to the real Personal Access Token from its vault. Mirrors the credential-injection approach in `add-gmail-tool`, but expressed via curl rather than an MCP server's stub config.

## Phase 1: Pre-flight

### Get a YNAB Personal Access Token

YNAB uses simple Personal Access Tokens — not OAuth, no scopes. Tell the user:

> Open https://app.ynab.com/settings/developer in a logged-in browser, click **New Token**, name it (e.g. `nanoclaw`), enter your YNAB password, and copy the token. It is shown **only once** — store it now.

Tokens do not expire and grant full read/write across every budget on the account. There is no scope mechanism — if the agent should never create or delete transactions, enforce that in the agent's CLAUDE.md instructions, not at the credential level.

### Create the OneCLI secrets (two host patterns)

YNAB has two API hosts that both serve `/v1/*`: the canonical `api.ynab.com` and the legacy `api.youneedabudget.com`. Claude's training data references the legacy host, so the agent will sometimes use it even when the documented examples say otherwise. Create a secret for each so either path resolves:

```bash
TOKEN="<token-from-above>"

onecli secrets create \
  --name "YNAB API Token" \
  --type generic \
  --value "$TOKEN" \
  --host-pattern "api.ynab.com" \
  --header-name "Authorization" \
  --value-format "Bearer {value}"

onecli secrets create \
  --name "YNAB API Token (legacy host)" \
  --type generic \
  --value "$TOKEN" \
  --host-pattern "api.youneedabudget.com" \
  --header-name "Authorization" \
  --value-format "Bearer {value}"
```

Each tells OneCLI: when any agent makes a request whose host matches the pattern, replace the `Authorization` header with `Bearer <real-token>`.

Verify both exist:

```bash
onecli secrets list | grep -i ynab
```

### Check agent secret-mode

For each target agent group, confirm OneCLI will inject the YNAB secret into its container. Find the OneCLI agent ID matching the group's `agentGroupId`:

```bash
onecli agents list
```

If that agent's `secretMode` is `all`, the YNAB secret's `api.ynab.com` hostPattern will auto-match. If it's `selective`, explicitly assign the YNAB secret:

```bash
onecli secrets list                # find the YNAB secret id from the previous step
onecli agents set-secrets --id <agent-id> --secret-ids <ynab-secret-id>
```

(Or flip the agent to `mode all`: `onecli agents set-secret-mode --id <agent-id> --mode all`. See CLAUDE.md "Gotcha: auto-created agents start in `selective` secret mode" for context.)

## Phase 2: Wire Per-Agent-Group

For each agent group that should have YNAB access (typically just the user's personal DM agent — financial data is rarely something to share across household / shared agents), append a YNAB section to `groups/<folder>/CLAUDE.md`. Use this verbatim, adjusting only the budget-name hint at the bottom:

```markdown
## YNAB (You Need A Budget)

You can read and modify the user's YNAB budget directly via the YNAB REST API. Use `curl` against `https://api.ynab.com/v1/*` with the literal placeholder `onecli-managed` as the bearer token. The OneCLI gateway swaps it for the real token in flight — never substitute, hardcode, or ask for the real token; the placeholder string is what you should send.

**Always use `api.ynab.com`** — not the legacy `api.youneedabudget.com`. (Both hosts work because the gateway has a secret for each, but `api.ynab.com` is the canonical one and is what the recipes below use.)

If a YNAB call returns `401 Unauthorized`, the token is already in the vault — the failure is something else (wrong host, missing header, bad path). Do not tell the user to "add the YNAB token" or "reconnect the integration." Re-try the call against `api.ynab.com` with the exact `Authorization: Bearer onecli-managed` header below and report the actual response body.

Just do it — never ask the user if they want you to try a YNAB call. If they ask "did I spend too much on groceries this month?", go find out.

### Common recipes

```bash
# List budgets
curl -s -H "Authorization: Bearer onecli-managed" \
  "https://api.ynab.com/v1/budgets"

# Month overview (categories, balances, spent so far) — `last-used` always resolves to the most recent budget
curl -s -H "Authorization: Bearer onecli-managed" \
  "https://api.ynab.com/v1/budgets/last-used/months/current"

# List transactions since a date
curl -s -H "Authorization: Bearer onecli-managed" \
  "https://api.ynab.com/v1/budgets/last-used/transactions?since_date=2026-04-01"

# List unapproved transactions only
curl -s -H "Authorization: Bearer onecli-managed" \
  "https://api.ynab.com/v1/budgets/last-used/transactions?type=unapproved"

# Transactions for one category since a date
curl -s -H "Authorization: Bearer onecli-managed" \
  "https://api.ynab.com/v1/budgets/last-used/categories/<category_id>/transactions?since_date=2026-04-01"

# List accounts
curl -s -H "Authorization: Bearer onecli-managed" \
  "https://api.ynab.com/v1/budgets/last-used/accounts"

# Create a transaction
curl -s -X POST -H "Authorization: Bearer onecli-managed" -H "Content-Type: application/json" \
  -d '{"transaction":{"account_id":"<id>","date":"2026-04-25","amount":-12990,"payee_name":"Coffee","category_id":"<id>","memo":"latte","cleared":"cleared","approved":true}}' \
  "https://api.ynab.com/v1/budgets/last-used/transactions"

# Update a transaction (e.g. recategorize)
curl -s -X PUT -H "Authorization: Bearer onecli-managed" -H "Content-Type: application/json" \
  -d '{"transaction":{"category_id":"<new_category_id>"}}' \
  "https://api.ynab.com/v1/budgets/last-used/transactions/<transaction_id>"

# Delete a transaction
curl -s -X DELETE -H "Authorization: Bearer onecli-managed" \
  "https://api.ynab.com/v1/budgets/last-used/transactions/<transaction_id>"
```

### Conventions

- **Amounts are milliunits.** $12.99 is `12990` (or `-12990` for an outflow). Always divide by 1000 before reporting to the user.
- **`last-used`** is a magic budget id that resolves to the most recently opened budget on the account. If the user has multiple budgets, list them first (`/budgets`) and use the explicit id.
- **Date format** is `YYYY-MM-DD`.
- **Rate limit:** 200 requests per token per hour. Most chat-driven workflows are nowhere near this; bulk-export-style queries (e.g. "summarize every transaction in every budget for the year") can hit it.
- **Read-after-write delay:** YNAB has a brief consistency window after `POST /transactions`. If you immediately re-query, the new row may not appear for a few seconds.
- Full API reference: https://api.ynab.com/v1
```

The placeholder `onecli-managed` is the literal string the agent should send — OneCLI looks for the `Authorization` header on outbound requests to `api.ynab.com` and replaces the entire header value with `Bearer <real-token>`. The agent never sees, stores, or processes the real token.

## Phase 3: Verify

### Test from the wired agent

Tell the user:

> In your `<agent-name>` chat, send: **"list my YNAB budgets"** or **"what did I spend on groceries this month?"**.
>
> The agent should run a curl command and return real data. The first call may take a fraction of a second longer while OneCLI does the header swap.

### Check logs if it isn't working

```bash
tail -100 logs/nanoclaw.log logs/nanoclaw.error.log | grep -iE 'ynab|onecli'
```

Common signals:
- Agent returns `401 Unauthorized` — OneCLI isn't injecting. Check (a) the secret was created with the exact host-pattern `api.ynab.com` (`onecli secrets list`), and (b) the agent's secret mode allows it (`onecli agents secrets --id <agent-id>`).
- Agent returns `Authorization: Bearer onecli-managed` is being received by YNAB unchanged (visible as 401 with body referencing `onecli-managed`) — the container isn't being routed through the OneCLI proxy. Check that `HTTPS_PROXY` and `NODE_EXTRA_CA_CERTS` are set in the running container (`ps aux | grep nanoclaw-v2`); these are added by `container-runner.ts` automatically when OneCLI is configured.
- Agent says "I don't have a way to access YNAB" — the CLAUDE.md section wasn't picked up. Confirm the file is `groups/<folder>/CLAUDE.md` (not `.claude/CLAUDE.md`), and either send a new message in that chat (CLAUDE.md is read fresh per session) or restart the container if the session is long-lived.

## Removal

1. Remove the `## YNAB (You Need A Budget)` section from each group's CLAUDE.md.
2. Delete the OneCLI secret: `onecli secrets list` to find the id, then `onecli secrets delete --id <id>`.
3. (Optional) Revoke the Personal Access Token at https://app.ynab.com/settings/developer.

No code, Dockerfile, or container image changes to undo — this skill makes none.

## Notes

- **Why not the MCP server?** The published `ynab-mcp-server@0.1.2` (April 2025) only ships 5 tools (`list_budgets`, `budget_summary`, `create_transaction`, `approve_transaction`, `get_unapproved_transactions`) and uses the deprecated `mcp-framework` package whose response format newer claude-code MCP clients reject in some calls. The maintainer rewrote it onto the official `@modelcontextprotocol/sdk` and added 12 more tools in November–December 2025, but those changes are unreleased on git main. Direct curl bypasses the framework drama, gives the agent the full API surface immediately, and ships zero new dependencies.
- **Token has no scopes.** YNAB Personal Access Tokens are full-account read/write. There is no `read-only` mode and no per-budget restriction. To prevent the agent from creating or deleting transactions, add a constraint in the group's CLAUDE.md (e.g. "Never POST, PUT, or DELETE against the YNAB API without explicit user confirmation"). Enforcement is at the prompt level only.
- **No webhook / no inbound channel.** This is read/write tool access only. YNAB does not push notifications; the agent has to be asked. To proactively report on budget overruns, set up a `/schedule` routine that asks the agent to check.

## Credits & references

- **YNAB API:** https://api.ynab.com/v1 (REST/JSON, Bearer auth, milliunits for amounts).
- **OneCLI generic secrets:** `onecli secrets create --type generic --header-name <h> --value-format <fmt>` — header-injection pattern used here matches the `add-gmail-tool` stub-credential approach but with a curl client rather than an MCP server.
- **Skill pattern:** modeled on [`add-gmail-tool`](../add-gmail-tool/SKILL.md) — same OneCLI credential flow, simpler delivery (no MCP server to install, just CLAUDE.md instructions).
- **Original v1 NanoClaw pattern:** the curl recipes here are derived from the YNAB section of `groups/main/CLAUDE.md` in v1, which used the same approach (file-mounted token + curl) for ~6 months in production. This skill modernizes it for v2 by replacing the file mount with OneCLI header injection.
