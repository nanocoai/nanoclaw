# OneCLI compatibility

These notes apply to the current OneCLI credential adapter, not OpenCode's
runtime contract.

NanoClaw's OneCLI 1.41.0 pin cannot refresh the ChatGPT OAuth credentials imported
by this skill: its refresh request omits the required client ID. After expiry,
use the [manual reauthentication procedure](SKILL.md#recover-a-chatgpt-login).
The same procedure also handles revoked credentials.

Do not assume a gateway upgrade resolves unattended ChatGPT operation.
OneCLI 1.43.1 removes the agent-grant API used by this NanoClaw version, so that
upgrade also requires an integration migration and validation of token refresh.
A different proxy is not established as compatible by these tests.

The container holds only a fixed non-secret sentinel. Token refresh and account
metadata remain gateway responsibilities; never work around refresh failures by
copying live credentials into a group. Remove this version-specific note once
the replacement integration and refresh behavior have been verified.
