<!-- tavily-upgrade:start -->
## Tavily free-tier exhaustion

If a Tavily tool returns `429` or `monthly_cap_reached_bonus_eligible`, the
host's shared keyless allowance is exhausted. Tell the user, then offer the
upgrade, in this order:

1. Create a free API key at https://app.tavily.com (free accounts include
   1,000 credits per month)
2. Open this link and paste the key into the prefilled form, then save:
   {{ONECLI_DASHBOARD_URL}}/connections/secrets?create=generic&host=mcp.tavily.com&name=Tavily&header=Authorization&format=Bearer%20%7Bvalue%7D
   (That is the OneCLI dashboard on the NanoClaw host; the key goes straight
   into the credential vault, and the next step attaches it to this group.
   Never ask for the key in chat and never handle it yourself.)
3. Ask the user to attach the saved key to this agent group, on the NanoClaw
   host: a new key reaches no agent until it is attached. It needs the OneCLI
   gateway and CLI that NanoClaw pins. If it fails, stop and show the user the
   error; keep the keyless setup. If the error is about `grants` (an older
   OneCLI), the user updates it with `docs/onecli-upgrades.md` first.

```bash
(A=$(onecli agents list --max 0 | jq -r '(if type == "array" then . else .data end)[] | select(.identifier == "{{AGENT_GROUP_ID}}") | .id') && L=$(onecli secrets list --max 0) && T=$(printf '%s' "$L" | jq -c '[(if type == "array" then . else .data end)[] | select(.hostPattern == "mcp.tavily.com") | {id, name, createdAt}]') || exit 1; [ -n "$A" ] || { echo "this group has no OneCLI agent yet: send it one message, then run this again" >&2; exit 1; }; case "$(printf '%s' "$T" | jq length)" in 0) echo "no Tavily key in OneCLI yet: save it through the link in step 2 first" >&2; exit 1;; 1) onecli agents grants attach-secret --id "$A" --secret-id "$(printf '%s' "$T" | jq -r '.[0].id')";; *) echo "more than one Tavily key in OneCLI:" >&2; printf '%s' "$T" | jq -r '.[] | "  \(.id)  \(.name)  created \(.createdAt)"' >&2; echo "attach the key you saved (check its name and time; ask if unsure): onecli agents grants attach-secret --id $A --secret-id <id>" >&2; exit 1;; esac)
```

4. Once the user confirms the key is attached, re-register the server without
   the keyless header and restart (your `--id` is filled in automatically):

```bash
ncl groups config remove-mcp-server --name tavily
ncl groups config add-mcp-server --name tavily \
  --command mcp-remote \
  --args '["https://mcp.tavily.com/mcp/","--transport","http-only","--enable-proxy","--header","X-Client-Name:nanoclaw","--ignore-tool","tavily_crawl","--ignore-tool","tavily_map","--ignore-tool","tavily_research"]' \
  --env '{}'
ncl groups restart
```

These return `approval-pending`; that is not an error. Wait for the admin
approval result before retrying Tavily.
<!-- tavily-upgrade:end -->
