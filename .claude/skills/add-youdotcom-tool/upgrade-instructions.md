<!-- youdotcom-upgrade:start -->
## You.com free-tier upgrade

You.com is registered on the keyless free tier: `you-search` only, capped at
100 queries per day (shared across the host). If a search returns `429`, or the
user needs content extraction, research, finance, or integration discovery,
offer the upgrade, in this order:

1. Create a free API key at https://you.com/platform/api-keys
2. Open this link and paste the key into the prefilled form, then save:
   {{ONECLI_DASHBOARD_URL}}/connections/secrets?create=generic&host=api.you.com&name=You.com&header=Authorization&format=Bearer%20%7Bvalue%7D
   (That is the OneCLI dashboard on the NanoClaw host; the key goes straight
   into the credential vault and is injected at the gateway. Never ask for
   the key in chat and never handle it yourself.)
3. Once the user confirms the key is saved, re-register the server against the
   full endpoint (all six tools) and restart (your `--id` is filled in
   automatically):

```bash
ncl groups config remove-mcp-server --name youdotcom
ncl groups config add-mcp-server --name youdotcom \
  --command mcp-remote \
  --args '["https://api.you.com/mcp?tools=you-search,you-contents,you-research,you-finance,you-balance,you-discover","--transport","http-only","--enable-proxy"]' \
  --env '{}'
ncl groups restart
```

These return `approval-pending`; that is not an error. Wait for the admin
approval result before retrying You.com.
<!-- youdotcom-upgrade:end -->
