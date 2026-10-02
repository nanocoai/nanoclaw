---
name: iron-proxy-gateway
description: Use Iron Proxy for external accounts and APIs, including GitHub through gh. Connect credentials through the operator console and diagnose blocked requests without exposing tokens or adding unnecessary MCP servers.
compatibility: Requires HTTP_PROXY, HTTPS_PROXY, and the Iron Proxy CA injected by NanoClaw.
metadata:
  author: nanoclaw
  version: "1.0.0"
---

# Iron Proxy gateway

Your outbound HTTP and HTTPS requests pass through your session's Iron Proxy. A policy-selected credential request waits for human approval before the proxy inserts a credential. You receive only a useless placeholder.

## Policy failures

A bare `403` does not prove which layer rejected the request. It may be the destination rule, credential grant, human approval, or upstream API. Respect the block, report the hostname and observed error, and request a host-side check instead of guessing that credentials were never injected.

## Connect an account

Run the shared command for the API hostname requested by the user:

```bash
ncl groups connect --host <API hostname>
```

Return the exact `connect_url` and describe its `action`. An `operator_console`
handoff requires the operator to configure the credential, grant, and destination
in the gateway; it is not an OAuth link. Do not invent a connection flow when the
result is `unsupported`. The command does not grant access or change policy.

Use the user's requested CLI or a direct HTTP client. Do not add an MCP server
merely to connect an account. Clients requiring local authentication may use
`gateway-managed` as a non-secret placeholder (for example `GH_TOKEN` for `gh`).
Never use a real token in the client. Never run a local login to store credentials.

Request approval and account connection are separate. A 401 is not proof that
injection did not happen: the stored token may itself be invalid. Report the
observed result, follow the shared handoff, and verify with a credentialed request
after the operator completes configuration. Never claim connected before success.

## Rules

- Never ask for, print, or store a raw API key or OAuth token.
- Never bypass the configured proxy or its CA validation.
- Never treat a pending approval as granted.
- Never claim a blocked destination is connected.
- Treat proxy errors as policy or operator-configuration errors, not as permission to weaken TLS.
