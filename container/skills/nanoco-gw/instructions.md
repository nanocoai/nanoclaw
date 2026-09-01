# NanoCo Gateway and external services

Call external provider APIs at their real HTTPS hostnames. The configured
NanoCo sidecar is transport only; Gateway classifies the request, applies
policy, and injects credentials after authorization. Never call the proxy or a
host named `sidecar` directly, and never probe `/health`, `/policy`,
`/classify`, `/operations`, or other guessed control paths.

`no_connection` or `needs_consent` means the user must open *Nancy (V2)* in
Slack, choose *Home → Connect accounts*, and press *Connect* or *Reconnect* for
that app. The one-time consent link stays on that user-bound Home surface; do
not invent or request a URL. Wait for confirmation before retrying once.
`policy_denied` means policy forbids the operation. Stop there: do not also
speculate that the user must reconnect, because Gateway has not reached the
connection check. Only `no_connection` or `needs_consent` proves that Connect
or Reconnect is required. `unclassified_request` means the method, provider
path, or query is outside the governed catalog. Report those denials accurately
without claiming the app is disconnected or retrying. A plain upstream `401`
or `403` is not a connection instruction.
Never ask for raw credentials. Slack message transport does not prove the
agent-facing Slack API connection is connected. That connection is the
consenting person's user-scoped grant, never the workspace message bot token.

Google Docs creation is exactly two calls: `POST /v1/documents` with only the
title, then `POST /v1/documents/{documentId}:batchUpdate` to insert content at
index 1. Never invent a one-shot create-with-content request and never use
Drive `files.create` as a substitute for writing document content.

For an agent-facing Slack message, call `POST https://slack.com/api/chat.postMessage`
with `Content-Type: application/json`. The JSON body must contain the exact
`channel` and non-empty `text`; add `thread_ts` only for a reply and
`reply_broadcast` only when the user explicitly asks for a channel-visible
thread reply. Do not use form encoding: the governed JSON contract is what
produces an approval card containing the exact `Destination` and `Message`. If
a write approval card omits either field, do not ask the user to approve it. This
text-message contract does not permit `blocks`, `attachments`, `metadata`, or
message-author overrides; do not add fields that the card does not present.

Slack conversation creation also uses governed JSON. Open a DM or MPDM with
`POST https://slack.com/api/conversations.open` and 1–8 comma-separated
`users`; its card must show Participants. Create a public channel with
`POST https://slack.com/api/conversations.create` and explicit
`{"name":"...","is_private":false}`; its card must show Channel name and
Private channel. Inviting users is a separate
`POST https://slack.com/api/conversations.invite` with explicit `channel`,
comma-separated `users`, and `force:false`; its card must show Destination,
Invitees, and Continue past invalid invitees. Channel creation, invitation,
and posting are three separately approved writes. Do not create private
channels with the current personal connection contract.

For a personal Canvas requested in a DM, use JSON
`POST https://slack.com/api/canvases.create` with optional `title` and non-empty
`document_content: {"type":"markdown","markdown":"..."}`. Do not treat a DM
as a channel Canvas. Use `POST /api/conversations.canvases.create` only when the
user explicitly requests a Canvas attached to a public or private channel, and
include its `channel_id`. Canvas cards must show Format and Canvas content;
channel Canvas cards must also show Destination. Existing Slack connections
need Reconnect after `canvases:write` is introduced.

For HubSpot, list contacts with `GET /crm/v3/objects/contacts` using documented
query parameters such as `limit` and `properties`. Filtering or sorting uses
the read-only JSON operation `POST /crm/v3/objects/contacts/search`; `sorts` is
not a query parameter on the list endpoint.
