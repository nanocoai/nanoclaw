#!/usr/bin/env bash
# Reach ONE tailnet host from inside the cluster, without putting the cluster
# on the tailnet and without a single added capability.
#
# WHY THIS SHAPE. The agent never needs the tailnet: its egress already goes
# through the Gateway, so only the Gateway has to reach the destination. And the
# Gateway must not change to get it — it keeps dialling the same hostname, and
# that hostname keeps appearing in its allow-list and in the template egress
# ceiling. So the reachability is solved BELOW the Gateway, in DNS and in a
# proxy, and the Gateway is none the wiser.
#
# WHY ZERO CAPABILITIES. The first cut used TS_DEST_IP, which is kernel DNAT and
# needs a TUN device and NET_ADMIN — and the image refuses it under
# TS_USERSPACE, so the two goals were exclusive. NET_ADMIN is exactly what a
# Pod Security `restricted` namespace forbids, and a customer cluster hardened
# enough to run Cilium with eBPF policy will enforce that. So the proxy must run
# with NO added capability and NO TUN. It does: tailscaled runs a userspace
# netstack, and forwarding is `tailscale nc` — a userspace connect over the
# tailnet — driven per-connection by a busybox `nc -lk -e` listener. Both ship
# in the image. Nothing here needs root, a device, or a capability.
#
# WHY NOT THE NODE. tailscaled on the node plus `--dns 100.100.100.100` on the
# Gateway is what the pre-Kubernetes deployment did (nanoco-tailnet-dns edits a
# `docker run` line), and it does not survive this shape: the Gateway is a
# Deployment, setup/gateway-k8s renders no DNS override, and on EKS there is no
# node to own. Everything here is ordinary cluster objects, so the same skill
# applies to EKS unchanged — only the CoreDNS insertion point differs.
#
# WHY A REWRITE AND NOT A HOSTS ENTRY. Mapping the name to the Service's
# ClusterIP would re-break every time the Service is recreated. Rewriting to the
# in-cluster Service NAME has no such coupling, and it keeps the SNI and Host
# header the client sent — TLS still terminates at the real destination with its
# own certificate, which is what makes this transparent rather than a MITM.
set -euo pipefail
exec 2>&1

usage() {
  cat >&2 <<'EOF'
usage: install.sh --system-namespace NAME --tailnet-fqdn HOST --tailnet-ip IPV4 \
  --secret-id ID --secret-key KEY --region REGION --image REF
EOF
  exit 2
}

system_namespace=''
tailnet_fqdn=''
tailnet_ip=''
secret_id=''
secret_key=''
region=''
image=''

while [[ $# -gt 0 ]]; do
  case "$1" in
    --system-namespace) system_namespace="${2:-}"; shift 2 ;;
    --tailnet-fqdn) tailnet_fqdn="${2:-}"; shift 2 ;;
    --tailnet-ip) tailnet_ip="${2:-}"; shift 2 ;;
    --secret-id) secret_id="${2:-}"; shift 2 ;;
    --secret-key) secret_key="${2:-}"; shift 2 ;;
    --region) region="${2:-}"; shift 2 ;;
    --image) image="${2:-}"; shift 2 ;;
    *) usage ;;
  esac
done

[[ "$system_namespace" =~ ^[a-z0-9]([-a-z0-9]*[a-z0-9])?$ ]] || usage
[[ "$tailnet_fqdn" =~ ^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$ ]] || usage
[[ "$tailnet_ip" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] || usage
[[ -n "$secret_id" && -n "$secret_key" ]] || usage
[[ "$region" =~ ^[a-z0-9-]+$ ]] || usage
[[ "$image" =~ ^[A-Za-z0-9._/@:+-]+$ && ${#image} -le 512 ]] || usage

kube=(sudo -n k3s kubectl)
name=tailnet-egress
socket=/var/run/tailscale/tailscaled.sock

# The auth key is read HERE, on the target, by the target's own instance role.
# The deploy machine deliberately cannot read these secrets, which is the same
# rule every other directory credential follows.
auth_key="$(python3 - "$secret_id" "$secret_key" "$region" <<'PY'
import json, sys
import boto3
secret_id, key, region = sys.argv[1], sys.argv[2], sys.argv[3]
value = boto3.client("secretsmanager", region_name=region).get_secret_value(SecretId=secret_id).get("SecretString")
if not isinstance(value, str):
    raise SystemExit(f"{secret_id} must contain a JSON SecretString")
found = json.loads(value).get(key)
if not isinstance(found, str) or not found:
    raise SystemExit(f"{secret_id} must contain a non-empty {key}")
if not found.startswith("tskey-"):
    raise SystemExit(f"{secret_id}:{key} is not a Tailscale auth key")
print(found)
PY
)"

"${kube[@]}" -n "$system_namespace" create secret generic "$name-auth" \
  --from-literal=TS_AUTHKEY="$auth_key" \
  --dry-run=client -o yaml | "${kube[@]}" apply -f - >/dev/null
unset auth_key

# Two containers, one socket. `tailscaled` (via the image's containerboot) owns
# auth and state in a userspace netstack; the relay only ever talks to it over
# the shared socket. Neither adds a capability, and the relay does not even run
# as root.
"${kube[@]}" apply -f - >/dev/null <<EOF
apiVersion: v1
kind: ServiceAccount
metadata:
  name: $name
  namespace: $system_namespace
  labels: {app.kubernetes.io/managed-by: nanoco-tailnet-egress}
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: $name
  namespace: $system_namespace
  labels: {app.kubernetes.io/managed-by: nanoco-tailnet-egress, app.kubernetes.io/name: $name}
spec:
  replicas: 1
  selector: {matchLabels: {app.kubernetes.io/name: $name}}
  template:
    metadata:
      labels: {app.kubernetes.io/name: $name, app.kubernetes.io/managed-by: nanoco-tailnet-egress}
    spec:
      serviceAccountName: $name
      automountServiceAccountToken: false
      securityContext:
        seccompProfile: {type: RuntimeDefault}
      containers:
        - name: tailscaled
          image: $image
          imagePullPolicy: IfNotPresent
          env:
            - {name: TS_USERSPACE, value: "true"}
            # containerboot notices it is in-cluster and, by default, keeps its
            # state in a kube Secret through the pod's ServiceAccount token.
            # That token is deliberately not mounted here — the proxy holds no
            # Kubernetes authority at all — so the default crash-looped on
            # "open /var/run/secrets/kubernetes.io/serviceaccount/namespace".
            # (No backticks in this heredoc: it is unquoted, and a backtick
            # is a command substitution.) Empty disables it; state lives in
            # TS_STATE_DIR, which is memory,
            # and a fresh pod re-auths with the reusable key.
            - {name: TS_KUBE_SECRET, value: ""}
            - {name: TS_SOCKET, value: $socket}
            - {name: TS_STATE_DIR, value: /var/lib/tailscale}
            - {name: TS_HOSTNAME, value: $name}
            - name: TS_AUTHKEY
              valueFrom: {secretKeyRef: {name: $name-auth, key: TS_AUTHKEY}}
          securityContext:
            allowPrivilegeEscalation: false
            capabilities: {drop: [ALL]}
          volumeMounts:
            - {name: socket, mountPath: /var/run/tailscale}
            - {name: state, mountPath: /var/lib/tailscale}
        - name: relay
          image: $image
          imagePullPolicy: IfNotPresent
          # One listener, one \`tailscale nc\` per accepted connection, bytes
          # relayed both ways over the shared socket. Port 443 is kept so the
          # rewrite needs no port translation.
          command: [nc, -lk, -p, "443", -e, tailscale, --socket=$socket, nc, "$tailnet_ip", "443"]
          ports: [{name: https, containerPort: 443, protocol: TCP}]
          # Ready means "can forward", not "is listening": the listener is up
          # the instant the container starts, and a Service that routes to it
          # while tailscaled is still authenticating hands every connection a
          # closed socket. Ask the daemon, over the same socket the relay uses.
          readinessProbe:
            exec: {command: [tailscale, --socket=$socket, status]}
            periodSeconds: 5
            failureThreshold: 3
          securityContext:
            runAsNonRoot: true
            runAsUser: 65534
            allowPrivilegeEscalation: false
            capabilities: {drop: [ALL]}
            readOnlyRootFilesystem: true
          volumeMounts:
            - {name: socket, mountPath: /var/run/tailscale}
      volumes:
        - {name: socket, emptyDir: {medium: Memory, sizeLimit: 1Mi}}
        - {name: state, emptyDir: {medium: Memory, sizeLimit: 16Mi}}
---
apiVersion: v1
kind: Service
metadata:
  name: $name
  namespace: $system_namespace
  labels: {app.kubernetes.io/managed-by: nanoco-tailnet-egress}
spec:
  type: ClusterIP
  selector: {app.kubernetes.io/name: $name}
  ports:
    - {name: https, port: 443, targetPort: 443, protocol: TCP}
EOF

"${kube[@]}" -n "$system_namespace" rollout status "deployment/$name" --timeout=180s >/dev/null

# THE DRIFT GUARD. The forwarding target is an address, and the name it stands
# for lives in somebody else's tailnet. If that device is rebuilt it takes a new
# address, and a proxy pointed at the old one fails in the least legible way
# available: DNS resolves, TCP connects, and the wrong host answers. Ask the
# proxy — the one process here that can see MagicDNS — what the name means, and
# refuse to leave a mapping that has drifted.
# By SHORT name: `tailscale ip` answers a bare hostname from the peer table,
# but hands a dotted name to the system resolver — which in a pod is cluster
# DNS, which has never heard of the tailnet. Measured: the FQDN form failed
# with "lookup … on 10.43.0.10:53: no such host" while the short form
# answered 100.88.77.23 from the same daemon.
tailnet_short="${tailnet_fqdn%%.*}"
resolved="$("${kube[@]}" -n "$system_namespace" exec "deployment/$name" -c tailscaled -- \
  tailscale --socket="$socket" ip -4 "$tailnet_short" 2>/dev/null | tr -d '[:space:]' || true)"
if [[ -z "$resolved" ]]; then
  echo "tailnet egress: could not resolve $tailnet_fqdn through the proxy; is the auth key valid and the ACL allowing this tag?" >&2
  exit 1
fi
if [[ "$resolved" != "$tailnet_ip" ]]; then
  echo "tailnet egress: $tailnet_fqdn is $resolved on the tailnet but this deployment forwards to $tailnet_ip; update the profile rather than leaving traffic pointed at the wrong host" >&2
  exit 1
fi

# CoreDNS: the whole Gateway-side change, and there is none in the Gateway.
# k3s imports custom/*.override INTO the default server block, so a rewrite here
# applies to every in-cluster resolver without touching the Corefile itself.
"${kube[@]}" -n kube-system create configmap coredns-custom \
  --from-literal=tailnet.override="rewrite name $tailnet_fqdn $name.$system_namespace.svc.cluster.local" \
  --dry-run=client -o yaml | "${kube[@]}" apply -f - >/dev/null
"${kube[@]}" -n kube-system rollout restart deployment/coredns >/dev/null
"${kube[@]}" -n kube-system rollout status deployment/coredns --timeout=120s >/dev/null

echo "tailnet egress ready: $tailnet_fqdn -> $name.$system_namespace.svc.cluster.local -> $tailnet_ip (userspace, no capabilities)"
