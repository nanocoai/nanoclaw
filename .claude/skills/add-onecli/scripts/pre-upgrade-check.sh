#!/bin/sh
# Lists what OneCLI's one-time grant conversion (first start of 1.44+) deletes
# or changes, for docs/onecli-upgrades.md. Exit 0: nothing; 1: findings;
# 2: the policy could not be read. Asks the gateway at $GW, one project at a
# time (1.42 cannot list projects): ONECLI_PROJECT selects one, else the CLI's.
set -u
: "${GW:?set GW to the gateway address, as in the Detect step}"
export ONECLI_API_HOST="$GW"
echo "Checking the policy at $GW, project ${ONECLI_PROJECT:-default}"
stop() { echo "STOP: $1; do not upgrade" >&2; exit 2; }
LIST='if type == "array" then . elif (type == "object") and ((.data | type) == "array") then .data else error("not a rule list") end'
NORM='def norm: if type == "object" then to_entries | sort_by(.key) | map(.value |= norm) | from_entries elif type == "array" then map(norm) else . end; def set: (. // []) | map(norm) | sort_by(tojson);'
found=0
for st in draft published; do
  r=$(onecli policy rules list --status "$st") && [ -n "$r" ] || stop "could not read the $st rules"
  d=$(onecli policy default get --status "$st") && [ -n "$d" ] || stop "could not read the $st default"
  hits=$(printf '%s' "$r" | jq -r "($LIST)"'[] | select((.isDefault | not) and ((.source == "blocklist") | not)) | select(any(.targets[]?; .kind == "network") or (((.conditions | type) == "array") and ((.conditions | length) > 0)) or ((.action == "allow") and ((.rateLimit == null) | not)) or (any(.targets[]?; .kind == "secret") and ((.action != "allow") or (.requireApproval == true)))) | "rule: \(.action)  \(.name)"') || stop "could not parse the $st rules"
  act=$(printf '%s' "$d" | jq -er 'if (type == "object") and ((.action | type) == "string") then .action else error("no default action") end') || stop "could not parse the $st default"
  # Only fields that decide what a rule does: per-copy ids, timestamps or labels never count as a change.
  # Identities and targets are sets: a copy may list them, or their keys, in another order.
  same=$(printf '%s' "$r" | jq -c "$NORM ($LIST) | map({priority, enabled, isDefault, source, action, rateLimit, rateLimitWindow, requireApproval, conditions: (.conditions | norm), identities: (.identities | set), targets: (.targets | set)} | tojson) | sort") || stop "could not parse the $st rules"
  if [ "$st" = draft ]; then draft="$same $act"; else published="$same $act"; fi
  if [ -n "$hits" ] || [ "$act" = block ]; then
    echo "$st policy, deleted or changed by the conversion:"
    [ -n "$hits" ] && printf '%s\n' "$hits"
    [ "$act" = block ] && echo "default: block (reset to allow)"
    found=1
  fi
done
# The conversion folds and publishes the draft, so unpublished edits take effect.
if [ "$draft" != "$published" ]; then
  echo "The draft has unpublished changes, and the conversion publishes the draft: publish or discard them in the OneCLI console first."
  found=1
fi
[ "$found" = 0 ] && echo "OK: the conversion deletes nothing" || exit 1
