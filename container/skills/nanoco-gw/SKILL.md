---
name: nanoco-gw
description: >-
  Use NanoCo Gateway for governed access to external providers such as Gmail,
  Google Calendar, Google Docs, Google Drive, Google Sheets, Slack, GitHub, and
  HubSpot. Load when a user asks to read or act on an external service. Call
  the provider API directly; NanoCo Gateway applies policy and injects the
  connected user's credential after authorization.
compatibility: Requires HTTP_PROXY and HTTPS_PROXY configured by the NanoCo session sidecar.
metadata:
  author: nanoco
  version: "0.1.0"
---

# NanoCo Gateway

External HTTPS requests pass through a per-session byte-relay sidecar to
NanoCo Gateway. Gateway classifies the provider operation, evaluates policy,
and injects credentials only after authorization. You never receive or handle
OAuth tokens, API keys, or the sidecar's mTLS identity.

## Call provider APIs directly

Use the real provider hostname. Standard HTTP clients honor the configured
proxy automatically; do not add an authorization header.

```bash
# Read one GitHub issue.
curl -fsS -H 'Accept: application/vnd.github+json' \
  https://api.github.com/repos/OWNER/REPO/issues/NUMBER

# List HubSpot contacts. Sorting is not a query parameter on this endpoint.
curl -fsS \
  'https://api.hubapi.com/crm/v3/objects/contacts?limit=10&properties=email,firstname,lastname,createdate'

# Search or sort HubSpot contacts through the read-only JSON search operation.
curl -fsS -X POST -H 'Content-Type: application/json' \
  --data '{"limit":10,"properties":["email","firstname","lastname","createdate"],"sorts":["-createdate"]}' \
  https://api.hubapi.com/crm/v3/objects/contacts/search
```

Use only provider-documented methods, paths, query parameters, and request
bodies. Do not broaden or mutate a request to get around a denial.

## Post an agent-facing Slack message as governed JSON

Slack message writes use the JSON request contract so the approval card can
show the exact destination and message held by Gateway:

```bash
curl -fsS -X POST -H 'Content-Type: application/json' \
  --data '{"channel":"CHANNEL_ID","text":"The exact message to send."}' \
  https://slack.com/api/chat.postMessage
```

For a thread reply, add `thread_ts`; add `reply_broadcast: true` only when the
user explicitly asks to surface that reply in the channel. Do not form-encode
agent-originated Slack writes. The approval card must include both Destination
and Message; if either is absent, stop rather than asking the user to approve.
Do not add `blocks`, `attachments`, `metadata`, or message-author overrides to
this text-message contract because those values are not represented on the
approval card.

## Create Slack conversations with explicit approvals

Opening a DM or multi-person DM uses one JSON request. Supply 1–8 comma-separated
participant user IDs and do not include the connected user's own ID:

```bash
curl -fsS -X POST -H 'Content-Type: application/json' \
  --data '{"users":"USER_ID,SECOND_USER_ID"}' \
  https://slack.com/api/conversations.open
```

The approval card must show Participants. If it does not, stop.

Creating a public channel, inviting people, and posting its first message are
three distinct governed writes and therefore three request-scoped approvals:

```bash
curl -fsS -X POST -H 'Content-Type: application/json' \
  --data '{"name":"nancy-project","is_private":false}' \
  https://slack.com/api/conversations.create

curl -fsS -X POST -H 'Content-Type: application/json' \
  --data '{"channel":"CREATED_CHANNEL_ID","users":"USER_ID","force":false}' \
  https://slack.com/api/conversations.invite
```

The first card must show Channel name and Private channel. The second must show
Destination, Invitees, and Continue past invalid invitees. Do not set
`is_private: true`: the reviewed personal connection currently supports public
channel creation only. Do not claim the workflow is complete until each
approved call succeeds and the governed message post succeeds.

## Create a Slack Canvas as governed JSON

For a personal Canvas requested in a DM, create a standalone Canvas owned by
the connected user. Do not send the DM ID to the channel-Canvas endpoint:

```bash
curl -fsS -X POST -H 'Content-Type: application/json' \
  --data '{"title":"Task tracker","document_content":{"type":"markdown","markdown":"# To Do\n- [ ] First task\n\n# In Progress\n\n# Done"}}' \
  https://slack.com/api/canvases.create
```

For a Canvas explicitly attached to a public or private channel, use
`POST https://slack.com/api/conversations.canvases.create` with JSON containing
`channel_id`, optional `title`, and the same non-empty `document_content`. A
standalone card must show Format and Canvas content; a channel Canvas card must
also show Destination. If those fields are missing, stop. `canvases:write` is
part of the governed personal Slack connection, so an existing connection must
be Reconnected after this scope is introduced.

## Create a populated Google Doc in two governed calls

Google Docs does not provide a create-with-content operation. Never invent one
and never substitute Drive `files.create` for document content.

1. Create the blank document with its title:

   ```bash
   curl -fsS -X POST -H 'Content-Type: application/json' \
     --data '{"title":"Quarterly plan"}' \
     https://docs.googleapis.com/v1/documents
   ```

2. Read `documentId` from that response, then insert the content at index 1:

   ```bash
   curl -fsS -X POST -H 'Content-Type: application/json' \
     --data '{"requests":[{"insertText":{"location":{"index":1},"text":"The document content."}}]}' \
     'https://docs.googleapis.com/v1/documents/DOCUMENT_ID:batchUpdate'
   ```

If either call is denied, report that exact call and stop. Do not claim the
document is complete after only the blank-document response.

## Interpret failures precisely

Read the response body and `x-nanoco-gw-*` headers. An HTTP status by itself
does not identify an account-connection problem.

- `no_connection` or `needs_consent`: tell the user to open *Nancy (V2)* in
  Slack, choose *Home → Connect accounts*, and press *Connect* or *Reconnect*
  for the named app. The consent link is one-time and user-bound on that Home
  surface, so do not invent or request a URL. Wait for the user to confirm the
  connection before retrying the original request once.
- `policy_denied`: explain that the active policy does not permit the
  classified operation. Stop there: Gateway has not reached the connection
  check, so do not also speculate that Connect or Reconnect is required. Do
  not claim the app is disconnected or retry.
- `unclassified_request`: explain that the method, provider path, or query is
  outside the current governed catalog. Report the request shape accurately;
  do not claim the app is disconnected, retry, or try nearby routes.
- Any other upstream `401` or `403`: report it as the
  provider's authentication or permission failure. Do not invent a connection
  flow.

## The sidecar is transport, not an API

Never send a request to the hostname or URL in `HTTP_PROXY` or `HTTPS_PROXY`,
including a host named `sidecar`. It exposes no agent control plane. Never
probe guessed paths such as `/`, `/help`, `/info`, `/health`, `/policy`,
`/classify`, or `/operations`.

## Sending Raw Email Through Gmail

Gmail's raw send and draft endpoints accept base64url-encoded RFC 5322/MIME.
`charset=UTF-8` covers the body only; it does not encode headers. Before building
a raw message, you MUST pass human-readable header text through the shared
encoder (ASCII is returned unchanged):

    encoded_subject="$(printf '%s' "$subject" | node /app/skills/nanoco-gw/scripts/encode-mime-header.mjs)"
    encoded_from_name="$(printf '%s' "$from_name" | node /app/skills/nanoco-gw/scripts/encode-mime-header.mjs)"

Use the output verbatim for an entire unstructured value such as `Subject`, or
for each display name in `From`, `Sender`, `Reply-To`, `To`, `Cc`, `Bcc`, and
their `Resent-*` variants:

    Subject: $encoded_subject
    From: $encoded_from_name <$from_address>

Encode each display name separately. Never pass a complete mailbox or address
list through the encoder: leave the address and header syntax unchanged. Apply
the same rule to mailbox-valued extension headers such as
`Disposition-Notification-To`. Never place raw non-ASCII display text directly
in a MIME header or hand-roll RFC 2047 encoding.

## Rules

- Never ask the user for a token, client secret, API key, or authorization
  header. Gateway owns credential custody.
- Never run a provider login CLI or a manual OAuth flow. Account connection is
  initiated only from the user's Slack Home *Connect accounts* tab.
- Slack message transport and an agent-facing Slack API connection are separate
  capabilities. Receiving this conversation does not prove Slack is connected
  for governed API calls. The latter is the consenting person's user-scoped
  grant; it is never the workspace bot token used to carry Slack messages.
- Respect classification, policy, and approval outcomes. Do not route around
  Gateway or retry a denied request through another tool.
- Do not infer connection state from a generic `401`, `403`, missing route, or
  policy denial.
