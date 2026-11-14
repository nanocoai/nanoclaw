# ChatGPT OAuth refresh with OneCLI

These notes apply to the current OneCLI credential adapter, not to any
provider's runtime contract.

OneCLI 1.42.0 could not refresh the ChatGPT OAuth credentials a provider
imports (for example OpenCode's ChatGPT sign-in): its refresh request omitted the
required client ID. OneCLI 1.43.1 sends it
([onecli/onecli#434](https://github.com/onecli/onecli/pull/434)), so the current
pin (1.45.0) includes the fix, but NanoClaw has not yet verified an unattended
refresh through it. Until it has, treat expiry as needing manual
reauthentication, for OpenCode the
[Recover a ChatGPT login](../../add-opencode/SKILL.md#recover-a-chatgpt-login) procedure.
The same procedure also handles revoked credentials.

A different proxy is not established as compatible by these tests.

The container holds only a fixed non-secret sentinel. Token refresh and account
metadata remain gateway responsibilities; never work around refresh failures by
copying live credentials into a group. Remove this version-specific note once
refresh through the pinned gateway has been verified.
