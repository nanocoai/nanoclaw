#!/bin/sh
# Says whether docs/onecli-upgrades.md must delete the Dial key before the pull.
# OneCLI's one-time grant conversion (first start of 1.44+) gives every `all`-mode
# agent every secret and deletes the rules that kept agents away, such as the old
# /add-dial-tool `Dial: blocked agents`. Once converted, grants decide, and a delete
# only takes Dial from the agents that should have it. Asks the gateway at $GW, one
# project at a time (ONECLI_PROJECT, else the CLI's). Exit 0: keep; 1: delete
# (prints the keys); 2: cannot tell. Reads only; --delete deletes those keys.
set -u
case "${1:-}" in "" | --delete) ;; *) echo "usage: dial-key-check.sh [--delete]" >&2; exit 2 ;; esac
stop() { echo "STOP: $1${PARTIAL:-}; do not upgrade" >&2; exit 2; }
[ -n "${GW:-}" ] || stop "set GW to the gateway address, as in the Detect step"
# The gateway container counts as the one at $GW only through a local Docker daemon,
# on a local address with a TCP binding of $GW's port. A localhost $GW is pinned to
# the address that binding uses, so every read below reaches that container.
C=${ONECLI_GATEWAY_CONTAINER:-onecli}
VERIFIED=
hp=${GW#*://}; hp=${hp%%/*}; gh=${hp%:*}; gp=${hp##*:}
[ "$gp" != "$hp" ] || gp=
case "$gh" in 127.0.0.1 | localhost | 172.17.0.1) ;; *) gp= ;; esac
# Every inspect goes to the one endpoint checked here, whatever DOCKER_HOST or DOCKER_CONTEXT say.
EP=$(docker context inspect -f '{{.Endpoints.docker.Host}}' 2>/dev/null) || EP=
case "$EP" in unix://* | npipe://*) ;; *) gp= ;; esac
if [ -n "$gp" ]; then
  B=$(docker -H "$EP" inspect -f '{{json .NetworkSettings.Ports}}' "$C" 2>/dev/null \
    | jq -r --arg p "$gp" '[(. // {}) | to_entries[] | select(.key | endswith("/tcp")) | (.value // [])[] | select(.HostPort == $p) | (.HostIp // "") | if . == "" then "0.0.0.0" else . end] | unique | join(" ")' 2>/dev/null) || B=
  case "$gh" in
    localhost) case " $B " in *" 127.0.0.1 "* | *" 0.0.0.0 "*) VERIFIED=127.0.0.1 ;; *" ::1 "* | *" :: "*) VERIFIED="[::1]" ;; esac ;;
    *) case " $B " in *" $gh "* | *" 0.0.0.0 "*) VERIFIED=$gh ;; esac ;;
  esac
  [ -z "$VERIFIED" ] || GW="${GW%%://*}://$VERIFIED:$gp"
fi
export ONECLI_API_HOST="$GW"
PJ=${ONECLI_PROJECT:-$(onecli config get project 2>/dev/null | jq -r '.value // empty' 2>/dev/null)}
P="project ${PJ:-of the OneCLI API key}"
LIST='if type == "array" then . elif (type == "object") and ((.data | type) == "array") then .data else error("not a list") end'
# Sets V and the stage S: old (before 1.42, no policy API), policy (1.42 or 1.43) or
# converted (1.44+). OneCLI 1.24 to 1.38 answer `unknown`, older ones no version.
read_version() {
  H=$(curl -fsS --max-time 10 "$GW/api/health") || stop "could not reach the gateway at $GW"
  V=$(printf '%s' "$H" | jq -ers 'if (length == 1) and (.[0] | type == "object") then .[0] else error("") end | if has("version") | not then "no version" elif .version == "unknown" then "unknown" elif (.version | type == "string") and (.version | test("\\A[0-9]{1,4}\\.[0-9]{1,4}\\.[0-9]{1,6}(\\+[0-9A-Za-z.-]{1,64})?\\z")) then .version else error("") end' 2>/dev/null) \
    || stop "the gateway at $GW does not report one release version, so it is unclear whether it has converted"
  case "$V" in
    unknown | "no version") S=old; return ;;
  esac
  R=${V%%+*}; M=${R%%.*}; m=${R#*.}; m=${m%%.*}
  if [ "$M" -gt 1 ] || { [ "$M" -eq 1 ] && [ "$m" -ge 44 ]; }; then S=converted
  elif [ "$M" -eq 1 ] && [ "$m" -ge 42 ]; then S=policy
  else S=old; fi
}
read_version
if [ "$S" = converted ]; then
  # OneCLI retries the conversion on every start while an agent is not selective.
  # Rules a failed conversion left are not readable on 1.44+; the post-upgrade check covers those.
  A=$(onecli agents list --max 0) || stop "could not list the OneCLI agents at $GW"
  N=$(printf '%s' "$A" | jq -er "[($LIST)[] | select((type != \"object\") or (.secretMode != \"selective\"))] | length") \
    || stop "could not read the OneCLI agent list at $GW"
  [ "$N" = 0 ] || stop "the gateway at $GW runs $V, but $N agent(s) in the $P are not in selective mode: its conversion has not finished, and the next start can give them every key, Dial included. Run the post-upgrade check"
  echo "keep: the gateway at $GW runs $V and every agent in the $P has converted, so grants decide which agents hold the Dial key; if it converted while \`Dial: blocked agents\` was in place, see \"If the gateway already converted\" in docs/onecli-upgrades.md"
  exit 0
fi
# A Dial key is any secret OneCLI injects on api.getdial.ai, whatever its name; this
# is the gateway's host matcher (split at the first `*`, case-insensitive).
HM='def hm($h): ascii_downcase as $p | ($h | ascii_downcase) as $x | ($p | index("*")) as $i | if $i == null then $p == $x else $p[:$i] as $a | $p[$i + 1:] as $b | ($x | length) >= ($a | length) + ($b | length) and ($x | startswith($a)) and ($x | endswith($b)) end;'
DIAL="$HM ($LIST)[] | select((type == \"object\") and ((.hostPattern | type) == \"string\") and (.hostPattern | hm(\"api.getdial.ai\")))"
L=$(onecli secrets list --max 0) && [ -n "$(printf '%s' "$L" | tr -d '[:space:]')" ] || stop "could not read the OneCLI secrets"
ids=$(printf '%s' "$L" | jq -r "$DIAL | .id | if (type == \"string\") and test(\"\\\\A[A-Za-z0-9_-]{1,128}\\\\z\") then . else error(\"bad secret id\") end") \
  || stop "could not read the OneCLI secrets"
[ -n "$ids" ] || { echo "keep: there is no Dial key at $GW in the $P"; exit 0; }
# What the conversion removes, as pre-upgrade-check.sh lists it, that restricts a
# Dial request today: a rule on the Dial host or a Dial key, or a `block` default.
J=$(printf '%s' "$ids" | jq -Rsc 'split("\n") | map(select(length > 0))')
GONE='select((.isDefault | not) and ((.source == "blocklist") | not)) | if (.targets | type) == "array" then . else error("no targets") end | select(any(.targets[]; .kind == "network") or (((.conditions | type) == "array") and ((.conditions | length) > 0)) or ((.action == "allow") and ((.rateLimit == null) | not)) or (any(.targets[]; .kind == "secret") and ((.action != "allow") or (.requireApproval == true))))'
LIMIT='select((.enabled != false) and ((.action != "allow") or (.requireApproval == true) or ((.rateLimit == null) | not)))'
TOUCH='select(any(.targets[]; (.kind == "network" and (((.hostPattern | type) != "string") or (.hostPattern | hm("api.getdial.ai")))) or (.kind == "secret" and (((.secretId | type) != "string") or (.secretId as $s | any($ids[]; . == $s))))))'
# Whose rules decide today. 1.42 enforces its policy unless POLICY_ENFORCE_V2 is
# set to anything but 1 or true; then the old pre-1.42 rules decide, and their
# deny mode is not readable. Without a verified container the old rules may decide.
mode=unknown
if [ "$S" = policy ] && [ -n "$VERIFIED" ] \
  && E=$(docker -H "$EP" inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$C" 2>/dev/null); then
  case "$(printf '%s\n' "$E" | grep '^POLICY_ENFORCE_V2=' | tail -1)" in
    "" | POLICY_ENFORCE_V2=1 | POLICY_ENFORCE_V2=true) mode=policy ;;
    *) mode=old ;;
  esac
fi
hits=
if [ "$S" = old ]; then
  hits="  it runs $V, older than 1.42: there is no policy to show what keeps agents away from Dial, and moving it to 1.42 or later can open Dial"
elif [ "$mode" = old ]; then
  hits="  POLICY_ENFORCE_V2 is off in $C, so the old pre-1.42 rules decide, and their deny mode is not readable"
elif [ "$mode" = unknown ]; then
  hits="  the container $C could not be shown to be the gateway at $GW, so its old pre-1.42 rules may decide, and their deny mode is not readable"
else
  # A project whose published policy lacks its default was never cut over: OneCLI
  # still decides it with the old rules.
  d=$(onecli policy default get --status published) && [ -n "$d" ] || stop "could not read the published default at $GW"
  cut=$(printf '%s' "$d" | jq -r 'if type == "object" then ((.id | type) == "string" and (.id | length) > 0) else error("") end') || stop "could not parse the published default at $GW"
  [ "$cut" = true ] || hits="  the $P at $GW was never moved to the policy API, so its old pre-1.42 rules decide, and their deny mode is not readable"
fi
if [ -z "$hits" ]; then
  for st in draft published; do
    r=$(onecli policy rules list --status "$st") && [ -n "$r" ] || stop "could not read the $st rules at $GW"
    d=$(onecli policy default get --status "$st") && [ -n "$d" ] || stop "could not read the $st default at $GW"
    act=$(printf '%s' "$d" | jq -er 'if (type == "object") and ((.action | type) == "string") then .action else error("") end') || stop "could not parse the $st default at $GW"
    h=$(printf '%s' "$r" | jq -r --argjson ids "$J" "$HM ($LIST)[] | if type == \"object\" then . else error(\"\") end | $GONE | $LIMIT | $TOUCH | \"  rule: \\(.action | tostring) \\(.name | tojson) ($st)\"") || stop "could not parse the $st rules at $GW"
    [ "$act" = block ] && h="$h
  default: block ($st)"
    hits="$hits
$h"
  done
fi
[ -n "$(printf '%s' "$hits" | tr -d '[:space:]')" ] || { echo "keep: nothing the conversion removes at $GW in the $P touches Dial, so no agent gains the Dial key"; exit 0; }
# Only an exact host or `*.<...>.getdial.ai` stays inside Dial's domain.
other=$(printf '%s' "$L" | jq -r "$DIAL | select(.hostPattern | ascii_downcase | (index(\"*\") == null) or (.[index(\"*\") + 1:] | endswith(\".getdial.ai\")) | not) | \"\\(.id) \\(.hostPattern | tojson)\"") || stop "could not read the OneCLI secrets"
[ -z "$other" ] || stop "these secrets reach api.getdial.ai through a wider host pattern, so they are not only Dial keys; decide about them by hand: $other"
# The list includes organization secrets, but a delete acts on the project only.
org=$(printf '%s' "$L" | jq -r "$DIAL | select((.scope // \"project\") != \"project\") | \"\\(.id) (\\(.scope | tojson))\"") || stop "could not read the OneCLI secrets"
[ -z "$org" ] || stop "these Dial keys are not this project's own secrets, and this check can delete only those: $org. Delete them in the OneCLI console before you pull"
echo "delete: the gateway at $GW ($V) has not converted yet, and the upgrade can remove what keeps agents away from Dial:"
printf '%s\n' "$hits" | sed '/^[[:space:]]*$/d'
echo "Dial keys in the $P (id, name):"
printf '%s' "$L" | jq -r "$DIAL | \"\\(.id) \\(.name | tojson)\""
[ "${1:-}" = --delete ] || exit 1
# A gateway that converts between the last read and a delete had this Dial rule
# in place, so the delete is still the one the conversion called for.
done=; rest=$(printf '%s ' $ids)
for id in $ids; do
  [ -z "$done" ] || PARTIAL=". Dial keys deleted so far: $done; not deleted: ${rest% }"
  read_version
  [ "$S" != converted ] || stop "the gateway at $GW now runs $V, so it has converted: keep the Dial keys not deleted, and see \"If the gateway already converted\" in docs/onecli-upgrades.md"
  PARTIAL=". A failed delete may still have gone through. Dial keys deleted already: ${done:-none}; left: ${rest% }. A rule that kept agents away from a deleted key goes with it, so check \`onecli secrets list\` and delete the Dial keys left in the OneCLI console before anything restarts the gateway"
  onecli secrets delete --id "$id" >/dev/null \
    || stop "could not delete the Dial key $id (\`onecli secrets delete\` acts only in the API key's own project)"
  echo "deleted Dial key $id"
  done="${done:+$done }$id"; rest=${rest#"$id "}
done
