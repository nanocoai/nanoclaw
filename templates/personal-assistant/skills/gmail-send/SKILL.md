---
name: gmail-send
description: Send one Gmail message through the NanoCo session sidecar and Gateway after showing the principal the exact outbound content. Use for Gmail sends; never add an Authorization header or handle an OAuth token.
---

# Gmail send

Use this skill only for an outbound Gmail message the principal requested.
The Gateway holds the OAuth grant and may pause the HTTP request while Slack
shows an ASK card. This skill never reads or supplies a bearer token.

1. Show the principal the exact `To`, `Cc`/`Bcc` (if any), subject, and body
   before starting the send. If their current message did not already approve
   those exact bytes, ask for confirmation.
2. Write a JSON file with mode `0600` containing only:

   ```json
   {
     "to": ["friend@example.com"],
     "cc": [],
     "bcc": [],
     "subject": "Hello",
     "body": "The exact plain-text body."
   }
   ```

3. Run:

   ```bash
   node ~/.claude/skills/gmail-send/scripts/send.mjs /path/to/spec.json
   ```

   The command may remain open for up to five minutes. That is expected: the
   Gateway is holding this exact request while the selected approver receives
   a Slack ASK card. Do not start a second send while the first is pending.
4. Delete the JSON file after the command returns.
5. Report the returned Gmail message id on success. On rejection, timeout, or
   `needs_consent`, report that outcome and do not retry automatically.

Hard rules:

- Never pass `Authorization`, cookies, an access token, a refresh token, a
  client secret, or a PKCE value.
- Never call a different origin or path. This helper is fixed to
  `POST https://gmail.googleapis.com/gmail/v1/users/me/messages/send`.
- Never bypass `HTTPS_PROXY`. The helper refuses to run unless the NanoCo
  sidecar proxy and mounted proxy CA are present.
- A Slack approval releases only the request already waiting in the Gateway;
  it is not permission for a later or changed message.
