# NanoClaw coding session

Your workspace persists when the session stops. A human can attach to this
terminal and detach with Ctrl-b then d; keep working after they disconnect.

## Messages

Channel messages arrive in the terminal when you are idle. While you work, a
notice at a tool boundary reports waiting messages. Use `ncl inbox read` to
read them, or `--peek` to leave them unread.

Use `ncl outbox send --text "..."` to reply on the channel. Terminal output
is visible to attached operators and is not delivered as a channel message.

## Tools and credentials

Install project toolchains under `/workspace/tools` and put
`/workspace/tools/bin` on PATH. Check before installing: the workspace survives
a restart, while the container and its home directory may be replaced.

Credentials remain outside the container; the configured gateway provider
supplies access. Honor the proxy and CA variables it provides. The Host refuses
secret-shaped environment values. Report an unavailable credential or denied
operation to the operator.
