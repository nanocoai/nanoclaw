---
name: onecli-gateway
description: >-
  OneCLI Gateway: transparent HTTPS proxy that injects stored credentials
  into outbound calls. You MUST use this skill when the user asks you to
  read emails, check calendar, access GitHub repos, create issues, check
  Stripe payments, or interact with ANY external service or API. Do NOT
  use browser extensions or OAuth CLI tools. Make HTTP requests directly;
  the gateway injects credentials automatically.
compatibility: Requires HTTPS_PROXY set in environment (automatic when launched via `onecli run`)
metadata:
  author: onecli
  version: "0.5.0"
---

# OneCLI Gateway

Your outbound HTTPS traffic is transparently proxied through the OneCLI
gateway, which injects stored credentials at the proxy boundary. You never
see or handle credential values directly.

## How to Access External Services

You have direct HTTP access to external APIs. OAuth apps (Gmail, GitHub,
Google Calendar, Google Drive, etc.) and API key services are all available
through the gateway. Just make the request directly; the gateway injects
credentials if the service is connected and attached to this agent. If not,
it returns an error that says what is missing (see below).

## Making Requests

Call the real API URL. The gateway intercepts the request and injects
credentials automatically.

```bash
curl -s "https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=5"
curl -s "https://api.github.com/user/repos?per_page=10"
curl -s "https://api.stripe.com/v1/charges?limit=5"
```

Standard HTTP clients (curl, fetch, requests, axios, Go net/http, git) all
honor the `HTTPS_PROXY` environment variable automatically. You do not need
to set any auth headers.

## Credential Stubs for MCP Servers

Some MCP servers need local credential files to start. Stubs for connected
apps are pre-written automatically. Files containing `"onecli-managed"`
values are managed by OneCLI — do NOT modify or delete them.

If an MCP server won't start due to missing credentials, create stubs
**before** starting it. Use `"onecli-managed"` as the placeholder for all
secret values, with file permissions `0600`. See the guide at:
https://www.onecli.sh/docs/guides/credential-stubs/general-app

## When a Request Fails

Check the `error` code in the response before the status. The gateway keeps
the service's status, which can be 400, 401 or 403.

**`app_not_connected` or `credential_not_found`: no stored credential matched
this request.** Usually none is stored yet. Show the user the link from the
response: `connect_url` for an app, `secret_url` for an API key (the response
says how to finish the link). If the user says a key is already saved, its
host or path pattern may not cover this URL: ask them to check it in the
OneCLI dashboard instead of saving another.

> To connect [service], open this link:
> [link from the error response]

If the response has no link, tell the user to open the OneCLI dashboard and
connect the service there.

**`access_restricted`: OneCLI holds a credential for this host, but none this
agent can use for this request.** That does not prove the service you
called is connected, whatever the response's message says. Several apps can
share one host: Gmail, Google Calendar and Google Drive all use
`www.googleapis.com`, so a Calendar request gets `access_restricted` when only
Drive is connected. Ask an admin to check in the OneCLI dashboard that the
service you called is connected, to connect it if it is not, and then to
attach it to this agent, which the dashboard names after this agent group.
If it is already attached, its sign-in may have stopped working: ask them to
reconnect it. For an app, the response's `manage_url` opens that app's page:
it offers to connect the app when no account is there, and each connected
account has its agent access. For an API key, the admin turns it on from this
agent's page. Saving a key or connecting an app through a link does not give
it to you. Until then, every retry gets the same error.

**Retry once the user confirms.** After a connect link, tell the user up
front that the first retry may return `access_restricted` until the
credential is attached. A `401` with none of these codes comes from the
service itself and usually means the stored key is wrong or expired. Do not
retry in a loop.

## Rules

- **Never** say "I don't have access to X" without first making the HTTP
  request through the proxy.
- **Never** use browser extensions, gcloud, or manual auth flows. The
  gateway handles credentials for you.
- **Never** ask the user for API keys or tokens directly. Direct them to
  connect the service in the OneCLI dashboard.
- **Never** suggest the user open Gmail/Calendar/GitHub in their browser
  when they ask you to read or interact with those services. You have API
  access. Use it.
- If the gateway returns a policy error (403 with a JSON body), respect
  the block. Do not retry or circumvent it.
