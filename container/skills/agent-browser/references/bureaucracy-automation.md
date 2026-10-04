# Bureaucracy automation (this install's extensions)

Beyond agent-browser's own auth vault and session persistence (see
`agent-browser skills get authentication`), this install adds three things:

## Setting up a new site

Never construct `agent-browser auth save ... --password-stdin` yourself —
you would end up typing the password into your own tool call. Instead call
the `request_credential_setup` tool with just the site key and login URL.
The user is asked for the username and password directly by the host; you
get back only a confirmation once it's saved. After that, log in any time
with `agent-browser auth login <site>` — you never handle the password.

## Two-factor / SMS / biometric codes

These are different from the vault: they're single-use and expire in
minutes, so there's no harm in you seeing one. After `auth login`, if the
page shows a code challenge (read it with `snapshot`, don't guess), just
ask the user for the code in a normal chat message and end your turn — the
browser session stays alive while you wait (this container and
agent-browser's own daemon persist independently of any single turn). When
the reply arrives, `agent-browser fill @ref "<code>"` and continue.

## Submitting anything

Before clicking submit on a claim, application, payment, or any other
action that commits something on the user's behalf, call
`request_submission_approval` with the pending action's id and a plain-
language summary of every field and value you're about to submit. Wait for
the chat confirmation telling you it was approved (or denied) before doing
anything else — never click submit, and never call `agent-browser confirm`
on your own judgment.
