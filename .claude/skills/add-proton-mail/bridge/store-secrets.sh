#!/usr/bin/env bash
# store-secrets.sh — copy the bridge password and Bridge's TLS certificate from
# the vault into this NanoClaw install, without either crossing stdout.
#
# Run from the project root after the Bridge login (init). Set-if-absent, like
# the skill engine's env-set: an existing PROTON_MAIL_BRIDGE_PASSWORD is left
# alone (delete the line to re-read it). Prints only what it did — never the
# password — so the setup log and terminal stay clean:
#   - PROTON_MAIL_BRIDGE_PASSWORD in .env (.env kept mode 600)
#   - store/proton-mail/bridge-cert.pem, and PROTON_MAIL_TLS_CA_FILE pointing
#     at it, so the adapter verifies Bridge's certificate instead of trusting
#     whatever answers on loopback.
set -euo pipefail
umask 077
IMAGE=${PROTON_BRIDGE_IMAGE:-nanoclaw-proton-bridge:latest}
VOLUME=${PROTON_BRIDGE_VOLUME:-nanoclaw-proton-bridge}
ENV_FILE=.env
CERT=store/proton-mail/bridge-cert.pem

read_field() {
  docker run --rm --log-driver none -v "$VOLUME:/root" "$IMAGE" secrets "$1"
}
has_key() {
  grep -Eq "^$1=.+" "$ENV_FILE" 2>/dev/null
}
append() {
  [[ -s "$ENV_FILE" && -n "$(tail -c1 "$ENV_FILE")" ]] && printf '\n' >>"$ENV_FILE"
  printf '%s=%s\n' "$1" "$2" >>"$ENV_FILE"
}

touch "$ENV_FILE"
chmod 600 "$ENV_FILE"

if has_key PROTON_MAIL_BRIDGE_PASSWORD; then
  echo "PROTON_MAIL_BRIDGE_PASSWORD already set in .env — left as is"
else
  pw=$(read_field password)
  [[ $pw =~ ^[A-Za-z0-9+/_-]{20,}$ ]] || { echo "could not read the bridge password from the vault" >&2; exit 1; }
  append PROTON_MAIL_BRIDGE_PASSWORD "$pw"
  echo "PROTON_MAIL_BRIDGE_PASSWORD written to .env (${#pw} characters)"
  unset pw
fi

mkdir -p "$(dirname "$CERT")"
tmp=$(mktemp "$CERT.XXXXXX")
read_field cert >"$tmp"
if ! openssl x509 -in "$tmp" -noout 2>/dev/null; then
  rm -f -- "${tmp:?}"
  echo "could not read Bridge's certificate from the vault" >&2
  exit 1
fi
mv -f -- "$tmp" "$CERT"
chmod 644 "$CERT"
echo "Bridge certificate saved to $CERT ($(openssl x509 -in "$CERT" -noout -fingerprint -sha256 | cut -d= -f2))"
if has_key PROTON_MAIL_TLS_CA_FILE; then
  echo "PROTON_MAIL_TLS_CA_FILE already set in .env — left as is"
else
  append PROTON_MAIL_TLS_CA_FILE "$CERT"
  echo "PROTON_MAIL_TLS_CA_FILE=$CERT written to .env"
fi
