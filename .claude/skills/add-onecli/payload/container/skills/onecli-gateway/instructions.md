# Credentials & External Services

Your HTTP requests go through the OneCLI proxy, which injects real credentials automatically. Just call any API directly (Gmail, GitHub, Slack, etc.) — the proxy adds auth before it reaches the service.

Use any method: curl, Python, a CLI tool, whatever fits. If a tool checks for credentials locally, pass any placeholder value — the proxy replaces it with real credentials at request time.

If a request fails with `app_not_connected` or `credential_not_found`, the error response contains a link (`connect_url`, or `secret_url` for an API key) — you MUST show it to the user as a bare URL on its own line (no angle brackets, no markdown link syntax) so they can click to connect. If it fails with `access_restricted`, OneCLI holds a credential for that host, but none this agent can use for that request. It may belong to another app on the host (Google apps share `www.googleapis.com`), so do not tell the user the service is connected: ask an admin to check that it is, connect it if not, and attach it to this agent. A retry fails until then. Run `/onecli-gateway` for the full error-handling flow. Never ask the user for API keys or tokens.
