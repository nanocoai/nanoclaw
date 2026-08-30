#!/usr/bin/env bash
# Install a loopback-only Traefik controller and give Governance plus every
# Backlot product its own Tailscale HTTPS origin. Distinct ports are distinct
# browser origins; no application path is stripped or rewritten.

set -euo pipefail

usage() {
  cat >&2 <<'EOF'
usage: install.sh --tailnet-host HOST --system-namespace NAME \
  --mocks-namespace NAME [--governance-port PORT] \
  [--backlot-control-port PORT] [--backlot-slack-port PORT] \
  [--backlot-teams-port PORT] [--backlot-okta-port PORT] \
  [--backlot-google-port PORT] [--backlot-salesforce-port PORT] \
  [--governance-development-actor EMAIL] \
  [--allow-loopback-only] \
  [--child-slack-public-port PORT] [--edge-domain DOMAIN --edge-router-image IMAGE] [--edge-port PORT] \
  [--render-dir ABSOLUTE_PATH]
EOF
  exit 2
}

tailnet_host=''
system_namespace=''
mocks_namespace=''
governance_listen_port=18080
control_listen_port=18090
slack_listen_port=18091
teams_listen_port=18092
okta_listen_port=18093
google_listen_port=18094
salesforce_listen_port=18095
child_chat_listen_port=18101
governance_port=10255
backlot_control_port=9080
backlot_slack_port=9081
backlot_teams_port=9082
backlot_okta_port=9083
backlot_google_port=9084
backlot_salesforce_port=9085
child_chat_public_port=19081
governance_development_actor=''
allow_loopback_only=''
edge_domain=''
edge_router_image=''
edge_port=18000
render_dir=''
while (($#)); do
  case "$1" in
    --tailnet-host) tailnet_host="${2:-}"; shift 2 ;;
    --system-namespace) system_namespace="${2:-}"; shift 2 ;;
    --mocks-namespace) mocks_namespace="${2:-}"; shift 2 ;;
    --governance-port) governance_port="${2:-}"; shift 2 ;;
    --backlot-control-port) backlot_control_port="${2:-}"; shift 2 ;;
    --backlot-slack-port) backlot_slack_port="${2:-}"; shift 2 ;;
    --backlot-teams-port) backlot_teams_port="${2:-}"; shift 2 ;;
    --backlot-okta-port) backlot_okta_port="${2:-}"; shift 2 ;;
    --backlot-google-port) backlot_google_port="${2:-}"; shift 2 ;;
    --backlot-salesforce-port) backlot_salesforce_port="${2:-}"; shift 2 ;;
    --governance-development-actor) governance_development_actor="${2:-}"; shift 2 ;;
    --allow-loopback-only) allow_loopback_only=1; shift ;;
    --child-slack-public-port) child_chat_public_port="${2:-}"; shift 2 ;;
    --edge-domain) edge_domain="${2:-}"; shift 2 ;;
    --edge-router-image) edge_router_image="${2:-}"; shift 2 ;;
    --edge-port) edge_port="${2:-}"; shift 2 ;;
    --render-dir) render_dir="${2:-}"; shift 2 ;;
    *) usage ;;
  esac
done

[[ "$tailnet_host" =~ ^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$ ]] || usage
[[ -z "$governance_development_actor" || "$governance_development_actor" =~ ^[A-Za-z0-9._+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,63}$ ]] || usage
[[ -z "$edge_domain" || "$edge_domain" =~ ^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$ ]] || usage
[[ -z "$edge_router_image" || ("$edge_router_image" =~ ^[A-Za-z0-9._/@:+-]+$ && ${#edge_router_image} -le 512) ]] || usage
[[ -z "$edge_domain" || -n "$edge_router_image" ]] || usage
[[ -z "$render_dir" || ("$render_dir" =~ ^/[A-Za-z0-9._/-]+$ && "$render_dir" != *..*) ]] || usage
for namespace in "$system_namespace" "$mocks_namespace"; do
  [[ "$namespace" =~ ^[a-z0-9]([-a-z0-9]*[a-z0-9])?$ ]] || usage
done
for port in \
  "$governance_listen_port" "$control_listen_port" "$slack_listen_port" \
  "$teams_listen_port" "$okta_listen_port" "$google_listen_port" "$salesforce_listen_port" \
  "$child_chat_listen_port" "$child_chat_public_port" "$edge_port" \
  "$governance_port" "$backlot_control_port" "$backlot_slack_port" \
  "$backlot_teams_port" "$backlot_okta_port" "$backlot_google_port" "$backlot_salesforce_port"; do
  [[ "$port" =~ ^[0-9]+$ ]] && ((port >= 1 && port <= 65535)) || usage
done

edge_entrypoint_arg=''
edge_system_listener=''
edge_mocks_listener=''
edge_ping_entrypoint=traefik
health_probe_port=8080
if [[ -n "$edge_domain" ]]; then
  edge_entrypoint_arg="            - --entrypoints.edge.address=0.0.0.0:$edge_port"
  edge_system_listener="    - {name: edge, protocol: HTTP, port: $edge_port, hostname: \"*.$edge_domain\", allowedRoutes: {namespaces: {from: Same}}}"
  edge_mocks_listener="$edge_system_listener"
  edge_ping_entrypoint=edge
  health_probe_port=$edge_port
fi

edge_parent_ref() {
  local gateway=$1
  [[ -n "$edge_domain" ]] || return 0
  printf '    - name: %s\n      sectionName: edge\n' "$gateway"
}

edge_hostname() {
  local label=$1
  [[ -n "$edge_domain" ]] || return 0
  printf '    - %s.%s\n' "$label" "$edge_domain"
}

# Gateway API's standard Set operation replaces every caller-supplied value.
# Governance therefore sees one explicit development actor, never a Tailscale
# header and never an identity chosen by the browser. Omitting the profile
# value leaves proxy-mode writes closed until a real OIDC proxy supplies it.
governance_identity_filter=''
if [[ -n "$governance_development_actor" ]]; then
  governance_identity_filter="$(cat <<EOF
      filters:
        - type: RequestHeaderModifier
          requestHeaderModifier:
            set:
              - {name: X-Forwarded-Email, value: $governance_development_actor}
EOF
)"
fi

backlot_control_origin="https://$tailnet_host:$backlot_control_port"
backlot_slack_origin="https://$tailnet_host:$backlot_slack_port"
backlot_teams_origin="https://$tailnet_host:$backlot_teams_port"
backlot_okta_origin="https://$tailnet_host:$backlot_okta_port"
backlot_google_origin="https://$tailnet_host:$backlot_google_port"
backlot_salesforce_origin="https://$tailnet_host:$backlot_salesforce_port"
if [[ -n "$edge_domain" ]]; then
  backlot_control_origin="https://control.$edge_domain"
  backlot_slack_origin="https://slack.$edge_domain"
  backlot_teams_origin="https://teams.$edge_domain"
  backlot_okta_origin="https://okta.$edge_domain"
  backlot_google_origin="https://google.$edge_domain"
  backlot_salesforce_origin="https://salesforce.$edge_domain"
fi

# Pinned to the exact K3s v1.35.7+k3s1 packaged artifacts this substrate
# already carries. Disabling the packaged `traefik` AddOn uninstalls both its
# controller and CRD chart, so the replacement must own both independently.
traefik_image='rancher/mirrored-library-traefik:3.7.8'
traefik_crd_chart='https://%{KUBERNETES_API}%/static/charts/traefik-crd-40.1.4+up40.1.0.tgz'
tailnet_ready=''
if [[ -n "$render_dir" ]]; then
  node_name=render-only-node
  state_dir="$render_dir"
else
  kube=(sudo -n k3s kubectl)
  if command -v tailscale >/dev/null 2>&1 && tailscale status >/dev/null 2>&1; then
    tailnet_ready=1
  elif [[ -z "$allow_loopback_only" ]]; then
    echo 'tailscale is unavailable; refusing without --allow-loopback-only' >&2
    exit 1
  fi
  node_name="$("${kube[@]}" get nodes -o jsonpath='{.items[0].metadata.name}')"
  [[ "$node_name" =~ ^[A-Za-z0-9]([-A-Za-z0-9._]*[A-Za-z0-9])?$ ]] || { echo 'cannot resolve a safe k3s node name' >&2; exit 1; }
  state_dir="${HOME}/.nanoco/tailnet-traefik"
fi
manifest="$state_dir/manifest.yaml"
crd_manifest="$state_dir/crd-chart.yaml"
install -d -m 0700 "$state_dir"
cat >"$crd_manifest" <<EOF
apiVersion: helm.cattle.io/v1
kind: HelmChart
metadata:
  name: nanoco-tailnet-traefik-crd
  namespace: kube-system
  labels: {app.kubernetes.io/managed-by: nanoco-tailnet-traefik}
spec:
  chart: $traefik_crd_chart
  driver: secret
  failurePolicy: retry
  forceConflicts: true
EOF
cat >"$manifest" <<EOF
apiVersion: v1
kind: ServiceAccount
metadata:
  name: nanoco-tailnet-traefik
  namespace: kube-system
  labels: {app.kubernetes.io/managed-by: nanoco-tailnet-traefik}
automountServiceAccountToken: true
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: nanoco-tailnet-traefik
  namespace: $system_namespace
  labels: {app.kubernetes.io/managed-by: nanoco-tailnet-traefik}
rules:
  - apiGroups: [""]
    resources: [configmaps, secrets, services]
    verbs: [get, list, watch]
  - apiGroups: [discovery.k8s.io]
    resources: [endpointslices]
    verbs: [list, watch]
  - apiGroups: [gateway.networking.k8s.io]
    resources:
      - gateways
      - httproutes
      - grpcroutes
      - tlsroutes
      - referencegrants
      - backendtlspolicies
    verbs: [get, list, watch]
  - apiGroups: [gateway.networking.k8s.io]
    resources: [gateways/status, httproutes/status, grpcroutes/status, tlsroutes/status, referencegrants/status, backendtlspolicies/status]
    verbs: [update]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: nanoco-tailnet-traefik
  namespace: $system_namespace
  labels: {app.kubernetes.io/managed-by: nanoco-tailnet-traefik}
roleRef: {apiGroup: rbac.authorization.k8s.io, kind: Role, name: nanoco-tailnet-traefik}
subjects:
  - {kind: ServiceAccount, name: nanoco-tailnet-traefik, namespace: kube-system}
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: nanoco-tailnet-traefik
  namespace: $mocks_namespace
  labels: {app.kubernetes.io/managed-by: nanoco-tailnet-traefik}
rules:
  - apiGroups: [""]
    resources: [configmaps, secrets, services]
    verbs: [get, list, watch]
  - apiGroups: [discovery.k8s.io]
    resources: [endpointslices]
    verbs: [list, watch]
  - apiGroups: [gateway.networking.k8s.io]
    resources:
      - gateways
      - httproutes
      - grpcroutes
      - tlsroutes
      - referencegrants
      - backendtlspolicies
    verbs: [get, list, watch]
  - apiGroups: [gateway.networking.k8s.io]
    resources: [gateways/status, httproutes/status, grpcroutes/status, tlsroutes/status, referencegrants/status, backendtlspolicies/status]
    verbs: [update]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: nanoco-tailnet-traefik
  namespace: $mocks_namespace
  labels: {app.kubernetes.io/managed-by: nanoco-tailnet-traefik}
roleRef: {apiGroup: rbac.authorization.k8s.io, kind: Role, name: nanoco-tailnet-traefik}
subjects:
  - {kind: ServiceAccount, name: nanoco-tailnet-traefik, namespace: kube-system}
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: nanoco-tailnet-traefik-gatewayclass
  labels: {app.kubernetes.io/managed-by: nanoco-tailnet-traefik}
rules:
  # Traefik's Gateway provider discovers the explicitly allowed namespaces
  # through the cluster-scoped Namespace informer before it reconciles a
  # GatewayClass. Read-only discovery only; workload and Secret access remains
  # confined to the two namespace Roles above.
  - apiGroups: [""]
    resources: [namespaces]
    verbs: [get, list, watch]
  - apiGroups: [gateway.networking.k8s.io]
    resources: [gatewayclasses]
    verbs: [get, list, watch]
  - apiGroups: [gateway.networking.k8s.io]
    resources: [gatewayclasses/status]
    verbs: [update]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: nanoco-tailnet-traefik-gatewayclass
  labels: {app.kubernetes.io/managed-by: nanoco-tailnet-traefik}
roleRef: {apiGroup: rbac.authorization.k8s.io, kind: ClusterRole, name: nanoco-tailnet-traefik-gatewayclass}
subjects:
  - {kind: ServiceAccount, name: nanoco-tailnet-traefik, namespace: kube-system}
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: nanoco-tailnet-traefik
  namespace: kube-system
  labels: {app.kubernetes.io/name: nanoco-tailnet-traefik, app.kubernetes.io/managed-by: nanoco-tailnet-traefik}
spec:
  replicas: 1
  strategy: {type: Recreate}
  revisionHistoryLimit: 2
  selector:
    matchLabels: {app.kubernetes.io/name: nanoco-tailnet-traefik}
  template:
    metadata:
      labels: {app.kubernetes.io/name: nanoco-tailnet-traefik, app.kubernetes.io/managed-by: nanoco-tailnet-traefik}
    spec:
      serviceAccountName: nanoco-tailnet-traefik
      hostNetwork: true
      dnsPolicy: ClusterFirstWithHostNet
      nodeSelector: {kubernetes.io/hostname: "$node_name"}
      automountServiceAccountToken: true
      enableServiceLinks: false
      securityContext:
        runAsNonRoot: true
        runAsUser: 65532
        runAsGroup: 65532
        seccompProfile: {type: RuntimeDefault}
      containers:
        - name: traefik
          image: $traefik_image
          imagePullPolicy: IfNotPresent
          args:
            - --entrypoints.governance.address=127.0.0.1:$governance_listen_port
            - --entrypoints.control.address=127.0.0.1:$control_listen_port
            - --entrypoints.slack.address=127.0.0.1:$slack_listen_port
            - --entrypoints.teams.address=127.0.0.1:$teams_listen_port
            - --entrypoints.okta.address=127.0.0.1:$okta_listen_port
            - --entrypoints.google.address=127.0.0.1:$google_listen_port
            - --entrypoints.salesforce.address=127.0.0.1:$salesforce_listen_port
            - --entrypoints.child-slack.address=127.0.0.1:$child_chat_listen_port
$edge_entrypoint_arg
            - --entrypoints.traefik.address=127.0.0.1:8080
            - --providers.kubernetesingress=false
            - --providers.kubernetescrd=false
            - --providers.kubernetesgateway=true
            - --providers.kubernetesgateway.experimentalchannel=false
            - --providers.kubernetesgateway.namespaces=$system_namespace,$mocks_namespace
            - --providers.kubernetesgateway.labelselector=app.kubernetes.io/managed-by=nanoco-tailnet-traefik
            - --api.dashboard=false
            - --ping=true
            - --ping.entrypoint=$edge_ping_entrypoint
            - --log.level=INFO
          readinessProbe:
            httpGet: {path: /ping, port: $health_probe_port, host: 127.0.0.1, scheme: HTTP}
            periodSeconds: 10
            timeoutSeconds: 3
            failureThreshold: 3
          livenessProbe:
            httpGet: {path: /ping, port: $health_probe_port, host: 127.0.0.1, scheme: HTTP}
            periodSeconds: 20
            timeoutSeconds: 3
            failureThreshold: 3
          resources:
            requests: {cpu: 25m, memory: 48Mi}
            limits: {memory: 192Mi}
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            capabilities: {drop: [ALL]}
          volumeMounts:
            - {name: tmp, mountPath: /tmp}
      volumes:
        - name: tmp
          emptyDir: {medium: Memory, sizeLimit: 32Mi}
---
apiVersion: gateway.networking.k8s.io/v1
kind: GatewayClass
metadata:
  name: nanoco-edge
  labels: {app.kubernetes.io/managed-by: nanoco-tailnet-traefik}
spec:
  controllerName: traefik.io/gateway-controller
---
apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
metadata:
  name: nanoco-system-edge
  namespace: $system_namespace
  labels: {app.kubernetes.io/managed-by: nanoco-tailnet-traefik}
spec:
  gatewayClassName: nanoco-edge
  listeners:
    - name: governance
      protocol: HTTP
      port: $governance_listen_port
      hostname: $tailnet_host
      allowedRoutes: {namespaces: {from: Same}}
    - name: child-slack
      protocol: HTTP
      port: $child_chat_listen_port
      hostname: $tailnet_host
      allowedRoutes: {namespaces: {from: Same}}
$edge_system_listener
---
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: governance-tailnet
  namespace: $system_namespace
  labels: {app.kubernetes.io/managed-by: nanoco-tailnet-traefik}
spec:
  parentRefs:
    - {name: nanoco-system-edge, sectionName: governance}
$(edge_parent_ref nanoco-system-edge)
  hostnames:
    - $tailnet_host
$(edge_hostname governance)
  rules:
    - backendRefs: [{name: governance-dashboard, port: $governance_port}]
$governance_identity_filter
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: governance-allow-tailnet-traefik
  namespace: $system_namespace
  labels: {app.kubernetes.io/managed-by: nanoco-tailnet-traefik}
spec:
  podSelector: {matchLabels: {app.kubernetes.io/name: governance}}
  policyTypes: [Ingress]
  ingress:
    - from:
        - namespaceSelector: {matchLabels: {kubernetes.io/metadata.name: kube-system}}
          podSelector: {matchLabels: {app.kubernetes.io/name: nanoco-tailnet-traefik}}
      ports: [{protocol: TCP, port: $governance_port}]
    - from:
        - namespaceSelector: {matchLabels: {kubernetes.io/metadata.name: $system_namespace}}
          podSelector: {matchLabels: {app.kubernetes.io/name: gateway}}
      ports: [{protocol: TCP, port: 10260}]
---
apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
metadata:
  name: nanoco-mocks-edge
  namespace: $mocks_namespace
  labels: {app.kubernetes.io/managed-by: nanoco-tailnet-traefik}
spec:
  gatewayClassName: nanoco-edge
  listeners:
    - {name: control, protocol: HTTP, port: $control_listen_port, hostname: $tailnet_host, allowedRoutes: {namespaces: {from: Same}}}
    - {name: slack, protocol: HTTP, port: $slack_listen_port, hostname: $tailnet_host, allowedRoutes: {namespaces: {from: Same}}}
    - {name: teams, protocol: HTTP, port: $teams_listen_port, hostname: $tailnet_host, allowedRoutes: {namespaces: {from: Same}}}
    - {name: okta, protocol: HTTP, port: $okta_listen_port, hostname: $tailnet_host, allowedRoutes: {namespaces: {from: Same}}}
    - {name: google, protocol: HTTP, port: $google_listen_port, hostname: $tailnet_host, allowedRoutes: {namespaces: {from: Same}}}
    - {name: salesforce, protocol: HTTP, port: $salesforce_listen_port, hostname: $tailnet_host, allowedRoutes: {namespaces: {from: Same}}}
$edge_mocks_listener
---
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: backlot-control-tailnet
  namespace: $mocks_namespace
  labels: {app.kubernetes.io/managed-by: nanoco-tailnet-traefik}
spec:
  parentRefs:
    - {name: nanoco-mocks-edge, sectionName: control}
$(edge_parent_ref nanoco-mocks-edge)
  hostnames:
    - $tailnet_host
$(edge_hostname control)
  rules: [{backendRefs: [{name: backlot, port: $backlot_control_port}]}]
---
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: backlot-slack-tailnet
  namespace: $mocks_namespace
  labels: {app.kubernetes.io/managed-by: nanoco-tailnet-traefik}
spec:
  parentRefs:
    - {name: nanoco-mocks-edge, sectionName: slack}
$(edge_parent_ref nanoco-mocks-edge)
  hostnames:
    - $tailnet_host
$(edge_hostname slack)
  rules: [{backendRefs: [{name: backlot, port: $backlot_slack_port}]}]
---
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: backlot-teams-tailnet
  namespace: $mocks_namespace
  labels: {app.kubernetes.io/managed-by: nanoco-tailnet-traefik}
spec:
  parentRefs:
    - {name: nanoco-mocks-edge, sectionName: teams}
$(edge_parent_ref nanoco-mocks-edge)
  hostnames:
    - $tailnet_host
$(edge_hostname teams)
  rules: [{backendRefs: [{name: backlot, port: $backlot_teams_port}]}]
---
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: backlot-okta-tailnet
  namespace: $mocks_namespace
  labels: {app.kubernetes.io/managed-by: nanoco-tailnet-traefik}
spec:
  parentRefs:
    - {name: nanoco-mocks-edge, sectionName: okta}
$(edge_parent_ref nanoco-mocks-edge)
  hostnames:
    - $tailnet_host
$(edge_hostname okta)
  rules: [{backendRefs: [{name: backlot, port: $backlot_okta_port}]}]
---
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: backlot-google-tailnet
  namespace: $mocks_namespace
  labels: {app.kubernetes.io/managed-by: nanoco-tailnet-traefik}
spec:
  parentRefs:
    - {name: nanoco-mocks-edge, sectionName: google}
$(edge_parent_ref nanoco-mocks-edge)
  hostnames:
    - $tailnet_host
$(edge_hostname google)
  rules: [{backendRefs: [{name: backlot, port: $backlot_google_port}]}]
---
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: backlot-salesforce-tailnet
  namespace: $mocks_namespace
  labels: {app.kubernetes.io/managed-by: nanoco-tailnet-traefik}
spec:
  parentRefs:
    - {name: nanoco-mocks-edge, sectionName: salesforce}
$(edge_parent_ref nanoco-mocks-edge)
  hostnames:
    - $tailnet_host
$(edge_hostname salesforce)
  rules: [{backendRefs: [{name: backlot, port: $backlot_salesforce_port}]}]
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: mocks-allow-tailnet-traefik
  namespace: $mocks_namespace
  labels: {app.kubernetes.io/managed-by: nanoco-tailnet-traefik}
spec:
  podSelector: {matchLabels: {app.kubernetes.io/name: backlot}}
  policyTypes: [Ingress]
  ingress:
    - from:
        - namespaceSelector: {matchLabels: {kubernetes.io/metadata.name: kube-system}}
          podSelector: {matchLabels: {app.kubernetes.io/name: nanoco-tailnet-traefik}}
      ports:
        - {protocol: TCP, port: $backlot_control_port}
        - {protocol: TCP, port: $backlot_slack_port}
        - {protocol: TCP, port: $backlot_teams_port}
        - {protocol: TCP, port: $backlot_okta_port}
        - {protocol: TCP, port: $backlot_google_port}
        - {protocol: TCP, port: $backlot_salesforce_port}
EOF

if [[ -n "$edge_domain" ]]; then
  if command -v sha256sum >/dev/null 2>&1; then
    edge_router_config_sha256="$(sha256sum "$0" | awk '{print $1}')"
  else
    edge_router_config_sha256="$(shasum -a 256 "$0" | awk '{print $1}')"
  fi
  cat >>"$manifest" <<EOF
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: nanoco-dev-env-edge-router
  namespace: $system_namespace
  labels: {app.kubernetes.io/managed-by: nanoco-tailnet-traefik}
data:
  router.ts: |
    import http from "node:http";
    import { connect } from "node:net";
    const domain = process.env.EDGE_DOMAIN;
    const port = Number(process.env.LISTEN_PORT);
    const refuse = (socket, status, text) => socket.end(
      \`HTTP/1.1 \${status} \${text}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n\`,
    );
    const targetFor = (host) => {
        const authority = (host ?? "").split(":", 1)[0].toLowerCase();
        const suffix = "." + domain;
        const label = authority.endsWith(suffix) ? authority.slice(0, -suffix.length) : "";
        const match = /^(slack|governance)-(nanoclaw-dev-[a-z0-9]{8})$/.exec(label);
        return match ? \`governed-child-edge.\${match[2]}.svc.cluster.local\` : null;
    };
    const server = http.createServer((req, res) => {
      if ((req.url ?? "").split("?", 1)[0] === "/health") {
        res.writeHead(200, {"content-type": "text/plain", "content-length": "2"});
        res.end("ok");
        return;
      }
      const target = targetFor(req.headers.host);
      if (!target) { res.writeHead(404); res.end(); return; }
      const upstream = http.request({
        host: target,
        port: 8080,
        agent: false,
        method: req.method,
        path: req.url,
        headers: {...req.headers, connection: "close"},
      }, (upstreamResponse) => {
        res.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.statusMessage, upstreamResponse.headers);
        upstreamResponse.pipe(res);
      });
      upstream.on("error", () => {
        if (!res.headersSent) res.writeHead(502);
        res.end();
      });
      req.pipe(upstream);
    });
    server.on("upgrade", (req, downstream, head) => {
      const target = targetFor(req.headers.host);
      if (!target) { refuse(downstream, 404, "Not Found"); return; }
      const upstream = connect({host: target, port: 8080});
      upstream.once("connect", () => {
        const headerLines = [];
        for (const [name, value] of Object.entries(req.headers)) {
          for (const item of Array.isArray(value) ? value : [value]) {
            if (item !== undefined) headerLines.push(name + ": " + item);
          }
        }
        upstream.write(
          (req.method ?? "GET") + " " + (req.url ?? "/") + " HTTP/" + req.httpVersion + "\r\n" +
          headerLines.join("\r\n") + "\r\n\r\n",
          "latin1",
        );
        if (head.length) upstream.write(head);
        downstream.pipe(upstream);
        upstream.pipe(downstream);
      });
      upstream.on("error", () => refuse(downstream, 502, "Bad Gateway"));
      downstream.on("error", () => upstream.destroy());
    });
    server.listen(port, "0.0.0.0");
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: nanoco-dev-env-edge-router
  namespace: $system_namespace
  labels: {app.kubernetes.io/managed-by: nanoco-tailnet-traefik}
spec:
  replicas: 1
  strategy: {type: RollingUpdate}
  selector:
    matchLabels: {app.kubernetes.io/name: nanoco-dev-env-edge-router}
  template:
    metadata:
      labels:
        app.kubernetes.io/name: nanoco-dev-env-edge-router
        app.kubernetes.io/managed-by: nanoco-tailnet-traefik
      annotations:
        nanoco.dev/edge-router-config-sha256: "$edge_router_config_sha256"
    spec:
      automountServiceAccountToken: false
      securityContext: {runAsUser: 501, runAsGroup: 1000, runAsNonRoot: true}
      containers:
        - name: router
          image: $edge_router_image
          imagePullPolicy: IfNotPresent
          command: [bun, /edge/router.ts]
          env:
            - {name: EDGE_DOMAIN, value: $edge_domain}
            - {name: LISTEN_PORT, value: "8080"}
          ports: [{name: http, containerPort: 8080, protocol: TCP}]
          readinessProbe: {httpGet: {path: /health, port: http}, periodSeconds: 2, failureThreshold: 30}
          resources: {requests: {cpu: 10m, memory: 32Mi}, limits: {cpu: 200m, memory: 128Mi}}
          securityContext: {allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: {drop: [ALL]}, seccompProfile: {type: RuntimeDefault}}
          volumeMounts:
            - {name: script, mountPath: /edge, readOnly: true}
      volumes:
        - {name: script, configMap: {name: nanoco-dev-env-edge-router, defaultMode: 292}}
---
apiVersion: v1
kind: Service
metadata:
  name: nanoco-dev-env-edge-router
  namespace: $system_namespace
  labels: {app.kubernetes.io/managed-by: nanoco-tailnet-traefik}
spec:
  selector: {app.kubernetes.io/name: nanoco-dev-env-edge-router}
  ports: [{name: http, port: 8080, targetPort: http, protocol: TCP}]
---
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: governed-children
  namespace: $system_namespace
  labels: {app.kubernetes.io/managed-by: nanoco-tailnet-traefik}
spec:
  parentRefs:
    - {name: nanoco-system-edge, sectionName: edge}
  hostnames:
    - "*.$edge_domain"
  rules: [{backendRefs: [{name: nanoco-dev-env-edge-router, port: 8080}]}]
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: nanoco-dev-env-edge-router
  namespace: $system_namespace
  labels: {app.kubernetes.io/managed-by: nanoco-tailnet-traefik}
spec:
  podSelector: {matchLabels: {app.kubernetes.io/name: nanoco-dev-env-edge-router}}
  policyTypes: [Ingress, Egress]
  ingress:
    - from:
        - namespaceSelector: {matchLabels: {kubernetes.io/metadata.name: kube-system}}
          podSelector: {matchLabels: {app.kubernetes.io/name: nanoco-tailnet-traefik}}
      ports: [{protocol: TCP, port: 8080}]
  egress:
    - to:
        - namespaceSelector: {matchLabels: {kubernetes.io/metadata.name: kube-system}}
      ports: [{protocol: UDP, port: 53}, {protocol: TCP, port: 53}]
    - to:
        - namespaceSelector: {matchLabels: {nanoclaw-dev-stamp: governed-child-kata}}
          podSelector: {matchLabels: {app: governed-child-edge}}
      ports: [{protocol: TCP, port: 8080}]
EOF
fi

if [[ -n "$render_dir" ]]; then
  echo "rendered-crd-manifest=$crd_manifest"
  echo "rendered-edge-manifest=$manifest"
  exit 0
fi

# Disable the packaged AddOn through the documented K3s config drop-in. This is
# the one deliberate replacement in the flow: K3s actively removes its public
# LoadBalancer Traefik and the bundled CRD release on restart. PostgreSQL and
# workload pods keep running while the single-node API server restarts.
disable_dir=/etc/rancher/k3s/config.yaml.d
disable_file="$disable_dir/99-nanoco-disable-traefik.yaml"
disable_tmp="$state_dir/disable-traefik.yaml"
cat >"$disable_tmp" <<'EOF'
disable+:
  - traefik
EOF
restart_k3s=''
if ! sudo -n cmp -s "$disable_tmp" "$disable_file"; then
  sudo -n install -d -m 0755 "$disable_dir"
  sudo -n install -m 0644 "$disable_tmp" "$disable_file"
  restart_k3s=1
fi
if [[ -n "$restart_k3s" ]]; then
  sudo -n systemctl restart k3s
fi

api_ready=''
for _ in {1..90}; do
  if "${kube[@]}" get node "$node_name" >/dev/null 2>&1; then
    api_ready=1
    break
  fi
  sleep 2
done
[[ -n "$api_ready" ]] || { echo 'k3s API did not recover after disabling packaged Traefik' >&2; exit 1; }
"${kube[@]}" wait --for=condition=Ready "node/$node_name" --timeout=180s >/dev/null

# The API server answering does not mean the AddOn is gone: K3s's deploy
# controller removes the packaged `traefik` and `traefik-crd` HelmChart objects
# a few seconds later, on its own resync. Wait for that removal before judging
# ownership, or a first run refuses exactly what the next run accepts.
packaged_charts_gone=''
for _ in {1..60}; do
  if ! "${kube[@]}" -n kube-system get helmchart traefik-crd >/dev/null 2>&1 \
    && ! "${kube[@]}" -n kube-system get helmchart traefik >/dev/null 2>&1; then
    packaged_charts_gone=1
    break
  fi
  sleep 2
done

# The replacement owns the CRDs first. Only after they exist do we apply the
# controller and HTTPRoutes; this avoids a window where K3s deletes custom
# resources together with its old CRD release.
if [[ -z "$packaged_charts_gone" ]]; then
  echo 'packaged traefik-crd HelmChart still exists after 120s of waiting for the K3s addon controller to remove the packaged charts; refusing ownership transfer' >&2
  exit 1
fi

# K3s removes the Traefik CRDs but deliberately leaves the shared Gateway API
# CRDs. Those survivors still name the deleted `traefik-crd` Helm release, and
# Helm correctly refuses to steal them implicitly. Transfer only that exact
# orphaned owner set before installing the byte-identical pinned CRD chart.
mapfile -t legacy_crds < <(
  "${kube[@]}" get crd -o json | jq -r '
    .items[]
    | select(.metadata.annotations["meta.helm.sh/release-name"] == "traefik-crd")
    | select(.metadata.annotations["meta.helm.sh/release-namespace"] == "kube-system")
    | .metadata.name
  '
)
if ((${#legacy_crds[@]} > 0)); then
  "${kube[@]}" annotate crd "${legacy_crds[@]}" \
    meta.helm.sh/release-name=nanoco-tailnet-traefik-crd \
    meta.helm.sh/release-namespace=kube-system \
    --overwrite >/dev/null
fi

"${kube[@]}" apply -f "$crd_manifest" >/dev/null
# A first attempt may have left a failed install Job behind after Helm rejected
# the orphaned CRDs. Keep a completed/running release intact; clear only that
# failed Job after ownership is repaired so K3s can retry the same HelmChart.
helm_job=helm-install-nanoco-tailnet-traefik-crd
if "${kube[@]}" -n kube-system get job "$helm_job" >/dev/null 2>&1; then
  job_failed="$("${kube[@]}" -n kube-system get job "$helm_job" -o jsonpath='{.status.failed}')"
  job_complete="$("${kube[@]}" -n kube-system get job "$helm_job" -o jsonpath='{.status.conditions[?(@.type=="Complete")].status}')"
  if [[ "${job_failed:-0}" != 0 && "$job_complete" != True ]]; then
    "${kube[@]}" -n kube-system delete job "$helm_job" --wait=true >/dev/null
  fi
fi
crds_ready=''
for _ in {1..90}; do
  if "${kube[@]}" api-resources --api-group=gateway.networking.k8s.io -o name 2>/dev/null \
      | awk '$0 == "httproutes.gateway.networking.k8s.io" { found=1 } END { exit !found }'; then
    crds_ready=1
    break
  fi
  sleep 2
done
[[ -n "$crds_ready" ]] || { echo 'recipe-owned Gateway API CRDs did not become ready' >&2; exit 1; }

# Backlot already owns one listener per product and supports explicit public
# origins. Project those origins into the pod before publishing them so every
# absolute API/OAuth/WebSocket URL names the browser-facing HTTPS origin rather
# than the pod IP. `kubectl set env` is idempotent; the first transition rolls
# Backlot once (its data is explicitly development-only emptyDir state).
"${kube[@]}" -n "$mocks_namespace" set env deployment/backlot \
  "BACKLOT_CONTROL_PUBLIC_ORIGIN=$backlot_control_origin" \
  "BACKLOT_SLACK_PUBLIC_ORIGIN=$backlot_slack_origin" \
  "BACKLOT_TEAMS_PUBLIC_ORIGIN=$backlot_teams_origin" \
  "BACKLOT_OKTA_PUBLIC_ORIGIN=$backlot_okta_origin" \
  "BACKLOT_GOOGLE_PUBLIC_ORIGIN=$backlot_google_origin" \
  "BACKLOT_SALESFORCE_PUBLIC_ORIGIN=$backlot_salesforce_origin" >/dev/null
"${kube[@]}" -n "$mocks_namespace" rollout status deployment/backlot --timeout=180s >/dev/null

backlot_status="$("${kube[@]}" get --raw "/api/v1/namespaces/$mocks_namespace/services/backlot:control/proxy/status")"
for product_port in \
  "control|$backlot_control_origin" "slack|$backlot_slack_origin" "teams|$backlot_teams_origin" \
  "okta|$backlot_okta_origin" "google|$backlot_google_origin" "salesforce|$backlot_salesforce_origin"; do
  IFS='|' read -r product public_origin <<<"$product_port"
  jq -e --arg product "$product" --arg origin "$public_origin" '
    any(.endpoints[]; .product == $product and .public.origin == $origin and .public.source == "configured")
  ' <<<"$backlot_status" >/dev/null || {
    echo "Backlot did not adopt the configured $product public origin" >&2
    exit 1
  }
done

"${kube[@]}" apply --dry-run=server -f "$manifest" >/dev/null
"${kube[@]}" apply -f "$manifest" >/dev/null
if [[ -n "$edge_domain" ]]; then
  "${kube[@]}" -n "$system_namespace" rollout status \
    deployment/nanoco-dev-env-edge-router --timeout=120s >/dev/null
fi

"${kube[@]}" wait --for=condition=Accepted gatewayclass/nanoco-edge --timeout=120s >/dev/null
"${kube[@]}" -n "$system_namespace" wait --for=condition=Programmed gateway/nanoco-system-edge --timeout=120s >/dev/null
"${kube[@]}" -n "$mocks_namespace" wait --for=condition=Programmed gateway/nanoco-mocks-edge --timeout=120s >/dev/null
routes_ready=''
expected_route_parents=1
[[ -z "$edge_domain" ]] || expected_route_parents=2
for _ in {1..60}; do
  routes="$("${kube[@]}" get httproute -A -l app.kubernetes.io/managed-by=nanoco-tailnet-traefik -o json)"
  if jq -e --argjson expected "$expected_route_parents" '
      [.items[] | select(.metadata.labels["nanoclaw.dev/env-id"] == null)] as $parentRoutes
      | ($parentRoutes | length) >= (if $expected == 2 then 8 else 7 end)
      and all($parentRoutes[];
        (.status.parents | length) == (if .metadata.name == "governed-children" then 1 else $expected end)
        and all(.status.parents[];
          any(.conditions[]?; .type == "Accepted" and .status == "True")
          and any(.conditions[]?; .type == "ResolvedRefs" and .status == "True")))
    ' <<<"$routes" >/dev/null; then
    routes_ready=1
    break
  fi
  sleep 2
done
[[ -n "$routes_ready" ]] || { echo 'Gateway API HTTPRoutes did not become Accepted with resolved backends' >&2; exit 1; }

# Retire the exact path-routing objects from the first private-ingress revision.
# Distinct origins make both prefix stripping and route-selection cookies wrong.
"${kube[@]}" -n "$system_namespace" delete middleware \
  governance-enter governance-select --ignore-not-found --wait=true >/dev/null
"${kube[@]}" -n "$mocks_namespace" delete middleware \
  control-enter control-select slack-enter slack-select okta-enter okta-select \
  --ignore-not-found --wait=true >/dev/null
"${kube[@]}" -n "$mocks_namespace" delete ingressroute backlot-tailnet \
  --ignore-not-found --wait=true >/dev/null

# Retire the controller-specific product routes only after every HTTPRoute is
# accepted and its backend references resolve. The Gateway API objects are the
# contract from this point forward; no prefix or cookie middleware survives.
"${kube[@]}" -n "$system_namespace" delete ingressroute governance-tailnet \
  --ignore-not-found --wait=true >/dev/null
"${kube[@]}" -n "$mocks_namespace" delete ingressroute \
  backlot-control-tailnet backlot-slack-tailnet backlot-teams-tailnet \
  backlot-okta-tailnet backlot-google-tailnet backlot-salesforce-tailnet \
  --ignore-not-found --wait=true >/dev/null

# Retire the cluster-scoped grants from the first recipe revision only after the
# replacement namespace Roles exist. Refuse to delete a same-named object that
# is not explicitly owned by this installer.
for legacy_rbac in clusterrolebinding clusterrole; do
  if "${kube[@]}" get "$legacy_rbac" nanoco-tailnet-traefik >/dev/null 2>&1; then
    legacy_owner="$("${kube[@]}" get "$legacy_rbac" nanoco-tailnet-traefik \
      -o jsonpath='{.metadata.labels.app\.kubernetes\.io/managed-by}')"
    if [[ "$legacy_owner" != nanoco-tailnet-traefik ]]; then
      echo "refusing to delete foreign $legacy_rbac/nanoco-tailnet-traefik" >&2
      exit 1
    fi
    "${kube[@]}" delete "$legacy_rbac" nanoco-tailnet-traefik --wait=true >/dev/null
  fi
done

"${kube[@]}" -n kube-system rollout status deploy/nanoco-tailnet-traefik --timeout=180s >/dev/null
if "${kube[@]}" -n kube-system get deploy traefik >/dev/null 2>&1; then
  echo 'packaged K3s Traefik still exists after disable+ restart' >&2
  exit 1
fi
if "${kube[@]}" -n kube-system get service traefik >/dev/null 2>&1; then
  echo 'packaged K3s Traefik LoadBalancer still exists after disable+ restart' >&2
  exit 1
fi

# Tailscale is transport only. Prove each exact-host origin reaches its
# product-owned route without making Governance or Traefik consume a
# Tailscale-specific identity header.
for route_probe in \
  "governance|$governance_listen_port|/health" \
  "control|$control_listen_port|/healthz" \
  "slack|$slack_listen_port|/" \
  "teams|$teams_listen_port|/" \
  "okta|$okta_listen_port|/__mock/state" \
  "google|$google_listen_port|/__mock/status" \
  "salesforce|$salesforce_listen_port|/"; do
  IFS='|' read -r product loopback_port path <<<"$route_probe"
  reachable=''
  for _ in {1..60}; do
    reachable="$(curl -sS -o /dev/null -w '%{http_code}' \
      -H "Host: $tailnet_host" "http://127.0.0.1:$loopback_port$path")"
    [[ "$reachable" == 200 ]] && break
    sleep 1
  done
  [[ "$reachable" == 200 ]] || {
    echo "private Traefik could not reach $product through its exact-host origin (HTTP $reachable)" >&2
    exit 1
  }
done

if [[ -n "$edge_domain" ]]; then
  for route_probe in \
    "governance|/health" \
    "control|/healthz" \
    "slack|/" \
    "teams|/" \
    "okta|/__mock/state" \
    "google|/__mock/status" \
    "salesforce|/"; do
    IFS='|' read -r product path <<<"$route_probe"
    edge_reachable=''
    for _ in {1..60}; do
      edge_reachable="$(curl -sS -o /dev/null -w '%{http_code}' \
        -H "Host: $product.$edge_domain" "http://127.0.0.1:$edge_port$path")"
      [[ "$edge_reachable" == 200 ]] && break
      sleep 1
    done
    [[ "$edge_reachable" == 200 ]] || {
      echo "private Traefik edge could not reach $product.$edge_domain (HTTP $edge_reachable)" >&2
      exit 1
    }
  done
fi

if [[ -z "$tailnet_ready" ]]; then
  echo 'loopback-only=true'
  echo "loopback-governance=http://127.0.0.1:$governance_listen_port"
  exit 0
fi

for serve_mapping in \
  "443|$governance_listen_port" \
  "$backlot_control_port|$control_listen_port" \
  "$backlot_slack_port|$slack_listen_port" \
  "$backlot_teams_port|$teams_listen_port" \
  "$backlot_okta_port|$okta_listen_port" \
  "$backlot_google_port|$google_listen_port" \
  "$backlot_salesforce_port|$salesforce_listen_port"; do
  IFS='|' read -r public_port loopback_port <<<"$serve_mapping"
  sudo -n tailscale serve --bg --yes --https="$public_port" "http://127.0.0.1:$loopback_port" >/dev/null
done
# One reserved legacy product origin for a claimed child's chat surface. The
# private edge uses the wildcard router above; this port remains the manual
# tailnet repair path owned by expose-child-services.sh.
sudo -n tailscale serve --bg --yes --https="$child_chat_public_port" \
  "http://127.0.0.1:$child_chat_listen_port" >/dev/null
serve_status="$(sudo -n tailscale serve status)"
for loopback_port in \
  "$governance_listen_port" "$control_listen_port" "$slack_listen_port" \
  "$teams_listen_port" "$okta_listen_port" "$google_listen_port" "$salesforce_listen_port" \
  "$child_chat_listen_port"; do
  grep -F "127.0.0.1:$loopback_port" <<<"$serve_status" >/dev/null
done

echo "tailnet-governance=https://$tailnet_host"
echo "tailnet-control=https://$tailnet_host:$backlot_control_port"
echo "tailnet-slack=https://$tailnet_host:$backlot_slack_port"
echo "tailnet-teams=https://$tailnet_host:$backlot_teams_port"
echo "tailnet-okta=https://$tailnet_host:$backlot_okta_port"
echo "tailnet-google=https://$tailnet_host:$backlot_google_port"
echo "tailnet-salesforce=https://$tailnet_host:$backlot_salesforce_port"
echo "tailnet-child-slack=https://$tailnet_host:$child_chat_public_port"
if [[ -n "$edge_domain" ]]; then
  echo "private-edge-domain=$edge_domain"
  echo "private-edge-target=http://0.0.0.0:$edge_port"
fi
