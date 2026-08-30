#!/usr/bin/env bash
set -euo pipefail

[[ $# == 3 ]] || { echo 'usage: cutover.sh NAMESPACE HOST_UNIT RECEIPT' >&2; exit 2; }
namespace="$1"
host_unit="$2"
receipt="$3"
[[ "$namespace" =~ ^[a-z0-9]([-a-z0-9]*[a-z0-9])?$ && "$host_unit" =~ ^[A-Za-z0-9_.@-]+\.service$ ]] || exit 2
[[ "$receipt" =~ ^/[A-Za-z0-9._/-]+$ && "$receipt" != / && "$receipt" != *'/../'* ]] || exit 2
kube=(sudo -n k3s kubectl -n "$namespace")

"${kube[@]}" get deployment nanoclaw-host >/dev/null
[[ "$("${kube[@]}" get deployment nanoclaw-host -o jsonpath='{.spec.replicas}')" == 0 ]] || { echo 'Host Deployment must be staged at zero replicas before first cutover' >&2; exit 1; }
systemctl --user disable --now "$host_unit"
if systemctl --user is-active --quiet "$host_unit"; then
  echo "$host_unit is still active" >&2
  exit 1
fi
rollback() {
  "${kube[@]}" scale deployment/nanoclaw-host --replicas=0 >/dev/null || true
  systemctl --user enable --now "$host_unit" || true
}
trap rollback ERR
"${kube[@]}" scale deployment/nanoclaw-host --replicas=1 >/dev/null
"${kube[@]}" rollout status deployment/nanoclaw-host --timeout=300s
install -d -m 0700 "$(dirname "$receipt")"
printf '{"writer":"kubernetes","deployment":"nanoclaw-host"}\n' >"$receipt"
chmod 0600 "$receipt"
trap - ERR

