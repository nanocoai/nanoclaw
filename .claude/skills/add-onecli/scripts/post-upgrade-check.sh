#!/bin/sh
# After the pull, for docs/onecli-upgrades.md: the 1.44+ conversion succeeded in
# this boot. Exit 0: it did; 1: it did not, or not yet; 2: could not check. Run on
# the gateway host. That credentials still reach the vendor is checked afterwards
# by a real agent reply (the guide's Verify step): a probe request cannot show it.
set -u
: "${GW:?set GW to the gateway address, as in the Detect step}"
export ONECLI_API_HOST="$GW"
stop() { echo "STOP: $1" >&2; exit 2; }
notdone() { echo "NOT DONE: $1" >&2; exit 1; }

C="${ONECLI_GATEWAY_CONTAINER:-onecli}"

# A gateway still before 1.44 has no conversion to wait for.
V=$(curl -fsS --max-time 10 "$GW/api/health" 2>/dev/null | jq -r '.version // empty' 2>/dev/null) || V=
case "$V" in
  0.* | 1.[0-9].* | 1.[1-3][0-9].* | 1.4[0-3].*) notdone "the gateway at $GW is $V: it has not been upgraded to the pin, so there is no conversion to check; follow step 2" ;;
esac

# Only this boot's line: an earlier boot's result says nothing about the gateway now running.
started=$(docker inspect -f '{{.State.StartedAt}}' "$C" 2>/dev/null) && [ -n "$started" ] \
  || stop "no local gateway container named $C: run this on the gateway host (set ONECLI_GATEWAY_CONTAINER if it has another name)"
line=$(docker logs --since "$started" "$C" 2>&1 | grep '\[grant-conversion\]' | tail -1)
[ -n "$line" ] || notdone "this boot has no grant-conversion result yet: wait a few seconds, then run this again"
# A verify failure can deny every request while the line still says 0 failed.
case "$line" in *", 0 failed,"*) ;; *) notdone "the conversion did not report 0 failed: $line" ;; esac
case "$line" in *", 0 verify-failed"*) ;; *) notdone "the conversion did not report 0 verify-failed: $line" ;; esac
# A preempted run was superseded before it finished and can leave agents in all mode.
case "$line" in *", 0 preempted,"*) ;; *) notdone "the conversion was preempted: restart the gateway, wait, then run this again: $line" ;; esac
AG=$(onecli agents list --max 0) || stop "could not list OneCLI agents at $GW (a gateway with an API token needs \`onecli auth login\` on this host first: pipe ONECLI_API_KEY from NanoClaw's .env into \`onecli auth login >/dev/null 2>&1 && echo signed in || echo 'sign-in failed' >&2\`, which reads it from stdin)"
N=$(printf '%s' "$AG" | jq -er '[(if type == "array" then . else .data end)[] | select(.secretMode == "all")] | length') \
  || stop "could not read the OneCLI agent list at $GW"
[ "$N" = 0 ] || notdone "$N agent(s) are still in all mode, so the conversion has not finished: restart the gateway, wait, then run this again"
echo "Conversion: $line"
echo "OK: this boot converted with 0 failed, 0 preempted and 0 verify-failed, and no agent is in all mode. Next: Verify, which ends with a real agent reply."
