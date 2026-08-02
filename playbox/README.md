# Household receipt playbox

The playbox is available only when NanoClaw starts with both
`NODE_ENV=development` and `NANOCLAW_PLAYBOX=true`. It listens on
`127.0.0.1:3210` and uses synthetic fixture data only.

From an operator workstation, create this exact tunnel:

```bash
ssh -L 3210:127.0.0.1:3210 ndexpense-server
```

Then open `http://127.0.0.1:3210`. The browser does not persist chat messages
or attachments. Reset clears in-memory event, duplicate, and fault state.

The scenario controls exercise the native NanoClaw channel contract. They do
not bypass the router, agent container, or MCP boundary. Real WhatsApp pairing
remains a separate rollout gate.
