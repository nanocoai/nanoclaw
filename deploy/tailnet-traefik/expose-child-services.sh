#!/usr/bin/env bash
# Project one claimed governed child's synced Backlot Service through the
# existing physical-cluster Traefik controller. No path rewriting, no cached
# ClusterIP, and Tailscale still points only at Traefik.

set -euo pipefail

usage() {
  echo 'usage: expose-child-services.sh --namespace NAME --tailnet-host HOST [--public-port PORT] [--edge-domain DOMAIN --governance-development-actor EMAIL] [--edge-port PORT] [--edge-only] [--render-dir ABSOLUTE_PATH]' >&2
  exit 2
}

namespace=''
tailnet_host=''
edge_domain=''
governance_development_actor=''
edge_port=18000
render_dir=''
edge_only=false
public_port=19081
listen_port=18101
backend_port=9081
governance_backend_port=10255
system_namespace=system
while (($#)); do
  case "$1" in
    --namespace) namespace="${2:-}"; shift 2 ;;
    --tailnet-host) tailnet_host="${2:-}"; shift 2 ;;
    --public-port) public_port="${2:-}"; shift 2 ;;
    --edge-domain) edge_domain="${2:-}"; shift 2 ;;
    --edge-port) edge_port="${2:-}"; shift 2 ;;
    --governance-development-actor) governance_development_actor="${2:-}"; shift 2 ;;
    --render-dir) render_dir="${2:-}"; shift 2 ;;
    --edge-only) edge_only=true; shift ;;
    *) usage ;;
  esac
done

[[ "$namespace" =~ ^nanoclaw-dev-[a-z0-9]{8}$ ]] || usage
[[ "$tailnet_host" =~ ^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$ ]] || usage
[[ -z "$edge_domain" || "$edge_domain" =~ ^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$ ]] || usage
[[ -z "$governance_development_actor" || "$governance_development_actor" =~ ^[A-Za-z0-9._+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,63}$ ]] || usage
[[ -z "$render_dir" || ("$render_dir" =~ ^/[A-Za-z0-9._/-]+$ && "$render_dir" != *..*) ]] || usage
[[ "$public_port" =~ ^[0-9]+$ ]] && ((public_port >= 1 && public_port <= 65535)) || usage
[[ "$edge_port" =~ ^[0-9]+$ ]] && ((edge_port >= 1024 && edge_port <= 65535)) || usage
[[ "$edge_only" == false || -n "$edge_domain" ]] || usage
[[ -z "$edge_domain" || -n "$governance_development_actor" ]] || usage

kube=(sudo -n k3s kubectl)
stamp="$("${kube[@]}" get namespace "$namespace" -o jsonpath='{.metadata.labels.nanoclaw-dev-stamp}')"
env_id="$("${kube[@]}" get namespace "$namespace" -o jsonpath='{.metadata.labels.nanoclaw-dev-env}')"
# Both spellings are one product: the runc and Kata tiers stamp the same
# governed child and differ only in isolationTier/runtimeClass.
[[ "$stamp" =~ ^governed-child(-kata)?$ && "$env_id" =~ ^env-[0-9a-f-]{36}$ ]] || {
  echo "$namespace is not an active claimed governed-child namespace (stamp: ${stamp:-none})" >&2
  exit 1
}

synced_service=backlot-x-system-x-vc
"${kube[@]}" -n "$namespace" get service "$synced_service" -o json | jq -e \
  --argjson port "$backend_port" \
  'any(.spec.ports[]; .port == $port)' >/dev/null || {
  echo "$namespace/$synced_service does not serve port $backend_port" >&2
  exit 1
}
target_dns="$synced_service.$namespace.svc.cluster.local"
child_subdomain="${namespace#nanoclaw-dev-}"
resource_name=governed-child-slack
governance_service=governance-x-nanoclaw-x-vc
governance_target_dns="$governance_service.$namespace.svc.cluster.local"
governance_resource_name="governed-child-$child_subdomain-governance"
governance_hostname="governance-$namespace.$edge_domain"
primary_parent_ref='    - {name: nanoco-system-edge, sectionName: child-slack}'
primary_hostname="    - $tailnet_host"
edge_parent_ref=''
edge_hostname=''
if [[ "$edge_only" == true ]]; then
  resource_name="governed-child-$child_subdomain-slack"
  primary_parent_ref='    - {name: nanoco-system-edge, sectionName: edge}'
  primary_hostname="    - slack-$child_subdomain.$edge_domain"
elif [[ -n "$edge_domain" ]]; then
  edge_parent_ref='    - {name: nanoco-system-edge, sectionName: edge}'
  edge_hostname="    - slack-$child_subdomain.$edge_domain"
fi
if [[ -n "$edge_domain" ]]; then
  "${kube[@]}" -n "$namespace" get service "$governance_service" -o json | jq -e \
    --argjson port "$governance_backend_port" \
    'any(.spec.ports[]; .port == $port)' >/dev/null || {
    echo "$namespace/$governance_service does not serve read-only dashboard port $governance_backend_port" >&2
    exit 1
  }
fi
ca_pem="$("${kube[@]}" -n "$namespace" get secret gateway-pki-x-system-x-vc -o json \
  | jq -er '.data["upstream-ca.pem"] | @base64d')"
openssl x509 -noout -subject <<<"$ca_pem" >/dev/null || {
  echo "$namespace/gateway-pki-x-system-x-vc carries no valid upstream CA" >&2
  exit 1
}
governance_ca_pem=''
if [[ -n "$edge_domain" ]]; then
  governance_ca_pem="$("${kube[@]}" -n "$namespace" get secret gateway-identity-x-system-x-vc -o json \
    | jq -er '.data["governance-identity-ca.pem"] | @base64d')"
  openssl x509 -noout -subject <<<"$governance_ca_pem" >/dev/null || {
    echo "$namespace/gateway-identity-x-system-x-vc carries no valid Governance identity CA" >&2
    exit 1
  }
fi

# The legacy tailnet development origin is deliberately single-writer. Private
# edge routes use --edge-only and an environment-derived resource name, so many
# exact subdomains coexist without retargeting this browser URL.
if [[ "$edge_only" == false ]]; then
  existing="$("${kube[@]}" -n "$system_namespace" get httproute governed-child-slack \
    -o jsonpath='{.metadata.labels.nanoclaw\.dev/env-id}' 2>/dev/null || true)"
  if [[ -n "$existing" && "$existing" != "$env_id" ]]; then
    echo "governed-child-slack already targets $existing; use --edge-only for an additive per-environment hostname" >&2
    exit 1
  fi
fi

state_dir="${render_dir:-${HOME}/.nanoco/tailnet-traefik}"
manifest="$state_dir/$resource_name.yaml"
install -d -m 0700 "$state_dir"
proxy_suffix="$child_subdomain"
proxy_name="governed-child-$proxy_suffix-edge-proxy"
proxy_image="$("${kube[@]}" -n "$system_namespace" get deployment governance -o json \
  | jq -er '.spec.template.spec.containers[] | select(.name == "governance") | .image')"
chat_proxy_port=19081
governance_proxy_port=19082
cat >"$manifest" <<EOF
apiVersion: v1
kind: ConfigMap
metadata:
  name: $proxy_name
  namespace: $system_namespace
  labels: {app.kubernetes.io/managed-by: nanoco-tailnet-traefik}
data:
  proxy.ts: |
    import { connect, createServer } from "node:net";
    const listenPort = Number(process.env.LISTEN_PORT);
    const targetPort = Number(process.env.TARGET_PORT);
    const targetHost = process.env.TARGET_HOST;
    if (!targetHost || !Number.isSafeInteger(listenPort) || !Number.isSafeInteger(targetPort)) process.exit(64);
    createServer((downstream) => {
      const upstream = connect({ host: targetHost, port: targetPort });
      downstream.pipe(upstream);
      upstream.pipe(downstream);
      downstream.on("error", () => upstream.destroy());
      upstream.on("error", () => downstream.destroy());
    }).listen(listenPort, "0.0.0.0");
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: $proxy_name
  namespace: $system_namespace
  labels:
    app.kubernetes.io/managed-by: nanoco-tailnet-traefik
    nanoclaw.dev/env-id: $env_id
spec:
  replicas: 1
  strategy: {type: RollingUpdate}
  selector:
    matchLabels: {nanoclaw.dev/edge-proxy: $proxy_suffix}
  template:
    metadata:
      labels:
        app.kubernetes.io/managed-by: nanoco-tailnet-traefik
        nanoclaw.dev/edge-proxy: $proxy_suffix
        nanoclaw.dev/env-id: $env_id
    spec:
      automountServiceAccountToken: false
      securityContext: {runAsUser: 501, runAsGroup: 1000, fsGroup: 1000}
      containers:
        - name: chat
          image: $proxy_image
          imagePullPolicy: IfNotPresent
          command: [bun, /opt/nanoco-edge/proxy.ts]
          env:
            - {name: HOME, value: /tmp}
            - {name: LISTEN_PORT, value: "$chat_proxy_port"}
            - {name: TARGET_HOST, value: $target_dns}
            - {name: TARGET_PORT, value: "$backend_port"}
          ports: [{name: chat, containerPort: $chat_proxy_port, protocol: TCP}]
          readinessProbe: {tcpSocket: {port: chat}, periodSeconds: 5, failureThreshold: 12}
          resources: {requests: {cpu: 5m, memory: 24Mi}, limits: {cpu: 100m, memory: 64Mi}}
          securityContext: {allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: {drop: [ALL]}, seccompProfile: {type: RuntimeDefault}}
          volumeMounts:
            - {name: proxy, mountPath: /opt/nanoco-edge, readOnly: true}
            - {name: tmp, mountPath: /tmp}
        - name: governance
          image: $proxy_image
          imagePullPolicy: IfNotPresent
          command: [bun, /opt/nanoco-edge/proxy.ts]
          env:
            - {name: HOME, value: /tmp}
            - {name: LISTEN_PORT, value: "$governance_proxy_port"}
            - {name: TARGET_HOST, value: $governance_target_dns}
            - {name: TARGET_PORT, value: "$governance_backend_port"}
          ports: [{name: governance, containerPort: $governance_proxy_port, protocol: TCP}]
          readinessProbe: {tcpSocket: {port: governance}, periodSeconds: 5, failureThreshold: 12}
          resources: {requests: {cpu: 5m, memory: 24Mi}, limits: {cpu: 100m, memory: 64Mi}}
          securityContext: {allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: {drop: [ALL]}, seccompProfile: {type: RuntimeDefault}}
          volumeMounts:
            - {name: proxy, mountPath: /opt/nanoco-edge, readOnly: true}
            - {name: tmp, mountPath: /tmp}
      volumes:
        - {name: proxy, configMap: {name: $proxy_name}}
        - {name: tmp, emptyDir: {medium: Memory, sizeLimit: 16Mi}}
---
apiVersion: v1
kind: Service
metadata:
  name: $resource_name
  namespace: $system_namespace
  labels:
    app.kubernetes.io/managed-by: nanoco-tailnet-traefik
    nanoclaw.dev/env-id: $env_id
spec:
  selector: {nanoclaw.dev/edge-proxy: $proxy_suffix}
  ports: [{name: https-chat, port: $backend_port, targetPort: chat, protocol: TCP}]
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: $resource_name-ca
  namespace: $system_namespace
  labels: {app.kubernetes.io/managed-by: nanoco-tailnet-traefik}
data:
  ca.crt: |
$(sed 's/^/    /' <<<"$ca_pem")
---
apiVersion: gateway.networking.k8s.io/v1
kind: BackendTLSPolicy
metadata:
  name: $resource_name
  namespace: $system_namespace
  labels: {app.kubernetes.io/managed-by: nanoco-tailnet-traefik}
spec:
  targetRefs:
    - {group: "", kind: Service, name: $resource_name}
  validation:
    hostname: backlot.system.svc.cluster.local
    caCertificateRefs:
      - {group: "", kind: ConfigMap, name: $resource_name-ca}
---
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: $resource_name
  namespace: $system_namespace
  labels:
    app.kubernetes.io/managed-by: nanoco-tailnet-traefik
    nanoclaw.dev/env-id: $env_id
spec:
  parentRefs:
$primary_parent_ref
$edge_parent_ref
  hostnames:
$primary_hostname
$edge_hostname
  rules: [{backendRefs: [{name: $resource_name, port: $backend_port}]}]
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: $proxy_name
  namespace: $system_namespace
  labels: {app.kubernetes.io/managed-by: nanoco-tailnet-traefik}
spec:
  podSelector: {matchLabels: {nanoclaw.dev/edge-proxy: $proxy_suffix}}
  policyTypes: [Ingress, Egress]
  ingress:
    - from:
        - namespaceSelector: {matchLabels: {kubernetes.io/metadata.name: kube-system}}
          podSelector: {matchLabels: {app.kubernetes.io/name: nanoco-tailnet-traefik}}
      ports:
        - {protocol: TCP, port: $chat_proxy_port}
        - {protocol: TCP, port: $governance_proxy_port}
  egress:
    - to:
        - namespaceSelector: {matchLabels: {kubernetes.io/metadata.name: kube-system}}
      ports: [{protocol: UDP, port: 53}, {protocol: TCP, port: 53}]
    - to:
        - namespaceSelector: {matchLabels: {kubernetes.io/metadata.name: $namespace}}
          podSelector: {matchLabels: {vcluster.loft.sh/managed-by: vc}}
      ports: [{protocol: TCP, port: $backend_port}, {protocol: TCP, port: $governance_backend_port}]
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: $resource_name-from-traefik
  namespace: $namespace
  labels:
    app.kubernetes.io/managed-by: nanoco-tailnet-traefik
    nanoclaw.dev/env-id: $env_id
spec:
  podSelector:
    matchLabels:
      app: backlot
      vcluster.loft.sh/managed-by: vc
      vcluster.loft.sh/namespace: system
  policyTypes: [Ingress]
  ingress:
    - from:
        - namespaceSelector: {matchLabels: {kubernetes.io/metadata.name: $system_namespace}}
          podSelector: {matchLabels: {nanoclaw.dev/edge-proxy: $proxy_suffix}}
      ports: [{protocol: TCP, port: $backend_port}]
EOF

if [[ -n "$edge_domain" ]]; then
  cat >>"$manifest" <<EOF
---
apiVersion: v1
kind: Service
metadata:
  name: $governance_resource_name
  namespace: $system_namespace
  labels:
    app.kubernetes.io/managed-by: nanoco-tailnet-traefik
    nanoclaw.dev/env-id: $env_id
spec:
  selector: {nanoclaw.dev/edge-proxy: $proxy_suffix}
  ports: [{name: https-governance, port: $governance_backend_port, targetPort: governance, protocol: TCP}]
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: $governance_resource_name-ca
  namespace: $system_namespace
  labels: {app.kubernetes.io/managed-by: nanoco-tailnet-traefik}
data:
  ca.crt: |
$(sed 's/^/    /' <<<"$governance_ca_pem")
---
apiVersion: gateway.networking.k8s.io/v1
kind: BackendTLSPolicy
metadata:
  name: $governance_resource_name
  namespace: $system_namespace
  labels: {app.kubernetes.io/managed-by: nanoco-tailnet-traefik}
spec:
  targetRefs:
    - {group: "", kind: Service, name: $governance_resource_name}
  validation:
    hostname: governance.nanoclaw.svc.cluster.local
    caCertificateRefs:
      - {group: "", kind: ConfigMap, name: $governance_resource_name-ca}
---
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: $governance_resource_name
  namespace: $system_namespace
  labels:
    app.kubernetes.io/managed-by: nanoco-tailnet-traefik
    nanoclaw.dev/env-id: $env_id
spec:
  parentRefs:
    - {name: nanoco-system-edge, sectionName: edge}
  hostnames:
    - $governance_hostname
  rules:
    - filters:
        - type: RequestHeaderModifier
          requestHeaderModifier:
            set:
              - {name: X-Forwarded-Email, value: $governance_development_actor}
      backendRefs: [{name: $governance_resource_name, port: $governance_backend_port}]
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: $governance_resource_name-from-traefik
  namespace: $namespace
  labels:
    app.kubernetes.io/managed-by: nanoco-tailnet-traefik
    nanoclaw.dev/env-id: $env_id
spec:
  podSelector:
    matchLabels:
      app: governance
      vcluster.loft.sh/managed-by: vc
      vcluster.loft.sh/namespace: nanoclaw
  policyTypes: [Ingress]
  ingress:
    - from:
        - namespaceSelector: {matchLabels: {kubernetes.io/metadata.name: $system_namespace}}
          podSelector: {matchLabels: {nanoclaw.dev/edge-proxy: $proxy_suffix}}
      ports: [{protocol: TCP, port: $governance_backend_port}]
EOF
fi

if [[ -n "$render_dir" ]]; then
  echo "rendered-child-manifest=$manifest"
  exit 0
fi

"${kube[@]}" apply --dry-run=server -f "$manifest" >/dev/null
"${kube[@]}" apply -f "$manifest" >/dev/null
"${kube[@]}" -n "$system_namespace" rollout status deployment/"$proxy_name" --timeout=60s >/dev/null

expected_parents=1
if [[ "$edge_only" == false && -n "$edge_domain" ]]; then expected_parents=2; fi
wait_for_route() {
  local name=$1 expected=$2 route
  for _ in {1..60}; do
    route="$("${kube[@]}" -n "$system_namespace" get httproute "$name" -o json)"
    if jq -e --argjson expected "$expected" '
        (.status.parents | length) == $expected
        and all(.status.parents[];
          any(.conditions[]?; .type == "Accepted" and .status == "True")
          and any(.conditions[]?; .type == "ResolvedRefs" and .status == "True"))
      ' <<<"$route" >/dev/null; then
      return 0
    fi
    sleep 1
  done
  return 1
}
wait_for_route "$resource_name" "$expected_parents" || {
  echo 'child Slack HTTPRoute was not accepted with a resolved backend' >&2
  exit 1
}
if [[ -n "$edge_domain" ]]; then
  wait_for_route "$governance_resource_name" 1 || {
    echo 'child governance HTTPRoute was not accepted with a resolved backend' >&2
    exit 1
  }
fi

if [[ "$edge_only" == false ]]; then
  body=''
  for _ in {1..60}; do
    # Match the consumer's authority exactly. Omitting the non-default port here
    # still returns the page but makes Backlot render a root-port WebSocket URL,
    # so HTTP 200 alone would bless a chat UI that disconnects in the browser.
    body="$(curl -sS -H "Host: $tailnet_host:$public_port" "http://127.0.0.1:$listen_port/" || true)"
    [[ "$body" == *"$tailnet_host:$public_port"* ]] && break
    sleep 1
  done
  [[ "$body" == *"$tailnet_host:$public_port"* ]] || {
    echo 'child Slack reached Traefik but did not render its external origin' >&2
    exit 1
  }
fi

if [[ -n "$edge_domain" ]]; then
  edge_host="slack-$child_subdomain.$edge_domain"
  edge_body=''
  for _ in {1..60}; do
    edge_body="$(curl -sS -H "Host: $edge_host" "http://127.0.0.1:$edge_port/" || true)"
    [[ "$edge_body" == *"$edge_host"* ]] && break
    sleep 1
  done
  [[ "$edge_body" == *"$edge_host"* ]] || {
    echo 'child Slack HTTPRoute did not render its exact private-edge hostname' >&2
    exit 1
  }

  governance_code=''
  for _ in {1..60}; do
    governance_code="$(curl -sS -o /dev/null -w '%{http_code}' \
      -H "Host: $governance_hostname" "http://127.0.0.1:$edge_port/health" || true)"
    [[ "$governance_code" == 200 ]] && break
    sleep 1
  done
  [[ "$governance_code" == 200 ]] || {
    echo "child governance edge did not become healthy (HTTP $governance_code)" >&2
    exit 1
  }
fi

# The standard route and verified backend TLS policy are serving. Retire only
# the exact controller-specific objects this helper previously owned.
if [[ "$edge_only" == false ]]; then
  "${kube[@]}" -n "$system_namespace" delete ingressroute governed-child-chat \
    --ignore-not-found --wait=true >/dev/null
  "${kube[@]}" -n "$system_namespace" delete serverstransport governed-child-chat-tls \
    --ignore-not-found --wait=true >/dev/null

  sudo -n tailscale serve --bg --yes --https="$public_port" "http://127.0.0.1:$listen_port" >/dev/null
  sudo -n tailscale serve status | grep -F "127.0.0.1:$listen_port" >/dev/null
  echo "child-slack=https://$tailnet_host:$public_port"
fi

echo "child-env=$env_id"
echo "child-service=$target_dns:$backend_port"
if [[ -n "$edge_domain" ]]; then
  echo "child-slack=https://slack-$child_subdomain.$edge_domain"
  echo "child-governance=https://$governance_hostname"
fi
