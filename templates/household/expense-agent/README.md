# Household Expense Agent template

Stamp this local template with:

```bash
ncl groups create --template household/expense-agent --name "Household Expense Agent"
```

After stamping, configure the group provider and model separately. The template
contains no provider credential and no account identity; the backend service
credential binds requests to the fixed household account.

Verify `groups/<folder>/container.json` contains only the `ndexpense` MCP server
from `.mcp.json`, with command `bun` and argument
`/app/src/ndexpense-mcp/server.ts`. The safe staging URL is currently
`https://ndexpense-api-staging.smartecom.workers.dev`. If Cloudflare provisions
a different hostname, update only this URL before stamping.

Do not put OpenRouter or ND Expense tokens in the template, group files,
environment values, service units, or test fixtures. Provider and backend live
credential checks remain separate operator gates.
