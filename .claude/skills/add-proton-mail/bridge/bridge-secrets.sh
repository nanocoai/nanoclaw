#!/bin/bash
# bridge-secrets.sh password|address|cert — print ONE field from Bridge's vault.
#
# `vault-editor read` prints the whole decrypted vault: the bridge password,
# but also the Proton session's refresh token, the key passphrase and the TLS
# private key. It is piped straight into one jq program here, inside the
# container, and only the one field asked for comes out, so the rest is never
# held in a variable or a file and never reaches the host, a log or Docker's
# log driver. Run with `docker run --rm --log-driver none`.
#   password — the IMAP/SMTP bridge password (the vault's raw bytes as unpadded
#              base64, the form Bridge's own `info` shows)
#   address  — the account's primary address, lowercased
#   cert     — Bridge's TLS certificate (PEM, public), for pinning
#
# One Bridge can hold several accounts, each with its own bridge password.
# With one, it is used. With more, PROTON_BRIDGE_ACCOUNT must name the one to
# use by its primary address; otherwise this refuses rather than guess.
# BRIDGE_VAULT_EDITOR overrides the vault reader (tests).
set -euo pipefail
field=${1:?usage: bridge-secrets.sh password|address|cert}
case "$field" in
  password | address | cert) ;;
  *) echo "unknown field: $field" >&2; exit 2 ;;
esac
editor=${BRIDGE_VAULT_EDITOR:-/protonmail/vault-editor}

# Prints the value, or a line starting "!" saying why there is none.
program='
  if $field == "cert" then (.Certs.Bridge.Cert // "")
  else
    [(.Users // [])[] | select($want == "" or ((.PrimaryEmail // "") | ascii_downcase) == ($want | ascii_downcase))] as $u
    | if ($u | length) > 1 then "!many " + ([$u[] | (.PrimaryEmail // "?")] | join(", "))
      elif ($u | length) == 0 and $want != "" then "!nomatch"
      elif $field == "password" then ($u[0].BridgePass // "")
      else ($u[0].PrimaryEmail // "" | ascii_downcase)
      end
  end'
status=0
value=$("$editor" read 2>/dev/null | jq -r --arg field "$field" --arg want "${PROTON_BRIDGE_ACCOUNT:-}" "$program") || status=$?
if ((status != 0)); then
  echo "could not read Bridge's vault (exit $status): its keyring may be damaged — see Troubleshooting, \"Bridge container keeps restarting\"" >&2
  exit 1
fi
case "$value" in
  '!many '*)
    echo "Bridge holds several accounts: ${value#\!many }." >&2
    echo "Add PROTON_BRIDGE_ACCOUNT=<primary address of the one this NanoClaw uses> to .env, then re-run." >&2
    exit 1
    ;;
  '!nomatch')
    echo "no account in Bridge has the primary address ${PROTON_BRIDGE_ACCOUNT} (PROTON_BRIDGE_ACCOUNT)" >&2
    exit 1
    ;;
  '') echo "no $field in the vault — has the account been signed in (init)?" >&2; exit 1 ;;
esac
case "$field" in
  password) printf '%s\n' "${value%%=*}" ;;
  cert) printf '%s' "$value" | base64 -d ;;
  *) printf '%s\n' "$value" ;;
esac
