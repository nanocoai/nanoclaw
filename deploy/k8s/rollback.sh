#!/usr/bin/env bash
set -euo pipefail

[[ $# == 3 ]] || { echo 'usage: rollback.sh NAMESPACE HOST_UNIT RECEIPT' >&2; exit 2; }
namespace="$1"
host_unit="$2"
receipt="$3"
[[ "$namespace" =~ ^[a-z0-9]([-a-z0-9]*[a-z0-9])?$ && "$host_unit" =~ ^[A-Za-z0-9_.@-]+\.service$ ]] || exit 2
[[ "$receipt" =~ ^/[A-Za-z0-9._/-]+$ && "$receipt" != / && "$receipt" != *'/../'* ]] || exit 2
kube=(sudo -n k3s kubectl -n "$namespace")

"${kube[@]}" scale deployment/nanoclaw-host --replicas=0 >/dev/null
"${kube[@]}" wait --for=delete pod -l app.kubernetes.io/name=nanoclaw-host --timeout=120s >/dev/null || true
systemctl --user enable --now "$host_unit"
systemctl --user is-active --quiet "$host_unit"
rm -f "$receipt"
