#!/bin/bash
# bridge-secrets.sh password|address|cert — print ONE field from Bridge's vault.
#
# `vault-editor read` prints the whole decrypted vault: the bridge password,
# but also the Proton session's refresh token, the key passphrase and the TLS
# private key. It is read here, inside the container, and only the one field
# asked for is printed, so the rest never reaches the host, a log or Docker's
# log driver. Run with `docker run --rm --log-driver none`.
#   password — the IMAP/SMTP bridge password (the vault's raw bytes as unpadded
#              base64, the form Bridge's own `info` shows)
#   address  — the account's primary address, lowercased
#   cert     — Bridge's TLS certificate (PEM, public), for pinning
set -euo pipefail
field=${1:?usage: bridge-secrets.sh password|address|cert}
filter=
case "$field" in
  password) filter='.Users[0].BridgePass // empty' ;;
  address) filter='.Users[0].PrimaryEmail // empty | ascii_downcase' ;;
  cert) filter='.Certs.Bridge.Cert // empty' ;;
  *) echo "unknown field: $field" >&2; exit 2 ;;
esac
value=$(/protonmail/vault-editor read 2>/dev/null | jq -r "$filter")
[[ -n "$value" ]] || { echo "no $field in the vault — has the account been signed in (init)?" >&2; exit 1; }
case "$field" in
  password) printf '%s\n' "${value%%=*}" ;;
  cert) printf '%s' "$value" | base64 -d ;;
  *) printf '%s\n' "$value" ;;
esac
