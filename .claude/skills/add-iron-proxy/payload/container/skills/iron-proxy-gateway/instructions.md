# Credentials and egress

For any external-account connection, run `ncl groups connect --host <API hostname>`.
Show the exact connect_url and explain whether it opens an operator console or
OAuth consent. A handoff or request approval does not mean the account is connected.
Use the requested CLI or HTTP client, not a new MCP server or local credential login.
Only documented non-secret placeholders may be used in clients; real credentials
stay in the gateway. Verify a credentialed request before reporting success.

Model-traffic defaults derive from the active provider contract. Other app actions
retain approval. A bare 401/403 does not identify which policy or credential check
failed. Report the observed error without guessing; do not bypass TLS or the proxy.
