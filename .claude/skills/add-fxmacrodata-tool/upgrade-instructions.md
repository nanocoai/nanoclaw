<!-- fxmacrodata-upgrade:start -->
## FXMacroData keyless scope

If an FXMacroData tool returns `subscription_required`, the request is outside
the keyless tier. The data exists; it needs an API key. Tell the user, then:

1. Answer what the keyless tier can: USD announcement data for the most recent
   90 days (each release readable 15 minutes after publication), the USD
   release calendar, USD press releases and the USD data catalogue, and for
   every currency forecast coverage and market sessions.
2. Offer the key: the user gets one at https://fxmacrodata.com/subscribe and
   an operator stores it in this copy's credential gateway for host
   `mcp.fxmacrodata.com` as `Authorization: Bearer {value}` (see
   `/add-fxmacrodata-tool`, Phase 5). Never ask for the key in chat, never put
   it in an MCP header, URL, or env var, and never handle it yourself.
3. Once the user confirms the key is stored, retry the original request. The
   `fxmacrodata` registration does not change. If it still returns
   `subscription_required`, ask an admin to run `ncl groups restart`.

If a tool returns HTTP `401` `invalid_api_key`, the stored key is wrong or
expired; ask the operator to replace it in the gateway.
<!-- fxmacrodata-upgrade:end -->
