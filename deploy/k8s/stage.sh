#!/usr/bin/env bash
set -euo pipefail
umask 077

usage() {
  echo 'usage: stage.sh --install-root PATH --namespace NAME --agents-namespace NAME --host-unit UNIT --install-id ID --deployment-id ID --agent-image REF --build-id ID --host-audit-port PORT --ncl-control-port PORT [--slack-api-url URL] [--allow-rollout] [--defer-rollout-wait]' >&2
  exit 2
}

install_root=''
namespace=''
agents_namespace=''
host_unit=''
install_id=''
deployment_id=''
agent_image=''
build_id=''
host_audit_port=''
ncl_control_port=''
slack_api_url=''
allow_rollout=''
defer_rollout_wait=''
while (($#)); do
  case "$1" in
    --install-root) install_root="${2:-}"; shift 2 ;;
    --namespace) namespace="${2:-}"; shift 2 ;;
    --agents-namespace) agents_namespace="${2:-}"; shift 2 ;;
    --host-unit) host_unit="${2:-}"; shift 2 ;;
    --install-id) install_id="${2:-}"; shift 2 ;;
    --deployment-id) deployment_id="${2:-}"; shift 2 ;;
    --agent-image) agent_image="${2:-}"; shift 2 ;;
    --build-id) build_id="${2:-}"; shift 2 ;;
    --host-audit-port) host_audit_port="${2:-}"; shift 2 ;;
    --ncl-control-port) ncl_control_port="${2:-}"; shift 2 ;;
    --slack-api-url) slack_api_url="${2:-}"; shift 2 ;;
    --allow-rollout) allow_rollout=1; shift ;;
    --defer-rollout-wait) defer_rollout_wait=1; shift ;;
    *) usage ;;
  esac
done

safe_name='^[a-z0-9]([-a-z0-9]*[a-z0-9])?$'
[[ "$install_root" =~ ^/[A-Za-z0-9._/-]+$ && "$install_root" != / && "$install_root" != *'/../'* ]] || usage
[[ "$namespace" =~ $safe_name && "$agents_namespace" =~ $safe_name && "$install_id" =~ $safe_name ]] || usage
[[ "$host_unit" =~ ^[A-Za-z0-9_.@-]+\.service$ ]] || usage
[[ "$deployment_id" =~ ^[A-Za-z0-9._-]{3,128}$ ]] || usage
[[ "$agent_image" =~ ^[A-Za-z0-9._/-]+@sha256:[0-9a-f]{64}$ ]] || usage
[[ "$build_id" =~ ^[A-Za-z0-9._-]+$ ]] || usage
[[ "$host_audit_port" =~ ^[0-9]+$ ]] && ((host_audit_port >= 1 && host_audit_port <= 65535)) || usage
[[ "$ncl_control_port" =~ ^[0-9]+$ ]] && ((ncl_control_port >= 1 && ncl_control_port <= 65535)) || usage
((ncl_control_port < 10257 || ncl_control_port > 10259)) || { echo 'NCL control port is reserved by k3s' >&2; exit 1; }
[[ -z "$slack_api_url" || "$slack_api_url" =~ ^https?://[^[:space:]]+/$ ]] || usage

host_dir="$install_root/host"
source_env="$host_dir/.env"
secrets_dir="$host_dir/data/secrets"
pki_dir="$install_root/gateway/data/pki"
ncl_pki_dir="$host_dir/data/host-audit-pki"
state_dir="$install_root/.nanoco/host-k8s"
context="$state_dir/build-context"
manifest="$state_dir/host.yaml"
runtime_env="$state_dir/runtime.env"
host_env="$state_dir/host.env"
kube=(sudo -n k3s kubectl)

fail() { echo "host-k8s stage: $*" >&2; exit 1; }
[[ -f "$source_env" ]] || fail "missing $source_env"
for file in central-db-password central-db-migrate-password host-audit-pseudonym.key; do
  [[ -s "$secrets_dir/$file" ]] || fail "missing Host runtime material: $file"
done
for file in gateway-server-ca.pem deployment-client.pem deployment-client-key.pem proxy-ca.pem; do
  [[ -s "$pki_dir/$file" ]] || fail "missing Host deployment PKI: $file"
done
for file in ncl-server.pem ncl-server-key.pem ncl-client-ca.pem governance-ncl-client.pem operator-ncl-client.pem operator-ncl-client-key.pem ncl-server-ca.pem host-client.pem host-client-key.pem governance-server-ca.pem; do
  [[ -s "$ncl_pki_dir/$file" ]] || fail "missing Host control or audit material: $file"
done
openssl verify -CAfile "$ncl_pki_dir/ncl-server-ca.pem" "$ncl_pki_dir/ncl-server.pem" >/dev/null
openssl verify -CAfile "$ncl_pki_dir/ncl-client-ca.pem" "$ncl_pki_dir/governance-ncl-client.pem" >/dev/null
openssl verify -CAfile "$ncl_pki_dir/ncl-client-ca.pem" "$ncl_pki_dir/operator-ncl-client.pem" >/dev/null

install -d -m 0700 "$state_dir"
rm -rf "$context"
install -d -m 0700 "$context"
for entry in package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc tsconfig.json src bin scripts container templates deploy; do
  [[ -e "$host_dir/$entry" ]] || fail "Host source is missing $entry"
  cp -a "$host_dir/$entry" "$context/$entry"
done
if find "$context" -name '.env*' -o -path '*/data/*' -o -path '*/groups/*' | grep -q .; then
  fail 'Host image context contains runtime or dotenv material'
fi

source_digest="$({ find "$context" -type f -print0 | sort -z | xargs -0 sha256sum; } | sha256sum | awk '{print $1}')"
image_arch="$(dpkg --print-architecture)"
case "$image_arch" in amd64|arm64) ;; *) fail "unsupported Host image architecture: $image_arch" ;; esac
image="nanoclaw-host:src-${source_digest:0:16}-${image_arch}"
if ! docker image inspect "$image" >/dev/null 2>&1; then
  docker build --platform "linux/$image_arch" --pull=false --provenance=false -f "$context/deploy/k8s/Dockerfile" -t "$image" "$context"
fi
[[ "$(docker image inspect "$image" --format '{{.Architecture}}')" == "$image_arch" ]] || fail "Host image is not $image_arch"
image_id="$(docker image inspect "$image" --format '{{.Id}}')"
docker save "$image" | sudo -n k3s ctr images import - >/dev/null
image_digest="$(sudo -n k3s ctr images list | awk -v ref="docker.io/library/$image" '$1 == ref {digest=$3} END {print digest}')"
[[ "$image_digest" =~ ^sha256:[0-9a-f]{64}$ ]] || fail 'imported Host image has no immutable manifest digest'
image_ref="docker.io/library/${image%:*}@$image_digest"
sudo -n k3s ctr images tag --force "docker.io/library/$image" "$image_ref" >/dev/null

materializer_image="nanoclaw-materializer:src-${source_digest:0:16}-${image_arch}"
if ! docker image inspect "$materializer_image" >/dev/null 2>&1; then
  docker build --platform "linux/$image_arch" --pull=false --provenance=false --build-arg "HOST_IMAGE=$image" \
    -f "$context/deploy/k8s/Materializer.Dockerfile" -t "$materializer_image" "$context"
fi
[[ "$(docker image inspect "$materializer_image" --format '{{.Architecture}}')" == "$image_arch" ]] || fail "materializer image is not $image_arch"
docker save "$materializer_image" | sudo -n k3s ctr images import - >/dev/null
materializer_digest="$(sudo -n k3s ctr images list | awk -v ref="docker.io/library/$materializer_image" '$1 == ref {digest=$3} END {print digest}')"
[[ "$materializer_digest" =~ ^sha256:[0-9a-f]{64}$ ]] || fail 'imported materializer image has no immutable manifest digest'
materializer_ref="docker.io/library/${materializer_image%:*}@$materializer_digest"
sudo -n k3s ctr images tag --force "docker.io/library/$materializer_image" "$materializer_ref" >/dev/null

cp "$source_env" "$runtime_env"
chmod 0600 "$runtime_env"
awk '
  /^($|#)/ { next }
  /^[A-Za-z_][A-Za-z0-9_]*=/ { key=$0; sub(/=.*/, "", key); if (seen[key]++) exit 2; next }
  { exit 1 }
' "$runtime_env" || fail "$source_env has an invalid or duplicate key"
upsert() {
  local key="$1" value="$2" next="$runtime_env.next"
  awk -v key="$key" -v value="$value" 'BEGIN{done=0} $0 ~ "^" key "=" {if(!done){print key "=" value; done=1}; next} {print} END{if(!done) print key "=" value}' "$runtime_env" >"$next"
  mv "$next" "$runtime_env"
  chmod 0600 "$runtime_env"
}
upsert NANOCLAW_INSTALL_ID "$install_id"
upsert NANOCLAW_DATA_DIR /var/lib/nanoclaw/data
upsert NANOCLAW_GROUPS_DIR /var/lib/nanoclaw/groups
upsert NANOCLAW_STORE_DIR /var/lib/nanoclaw/store
upsert NANOCO_SESSION_MATERIAL_ROOT /var/lib/nanoclaw/session-materials
upsert NANOCLAW_SESSION_MATERIAL_ROOT /var/lib/nanoclaw/session-materials
upsert NANOCLAW_TEMPLATES_DIR /opt/nanoclaw/templates
upsert NANOCLAW_DB_PASSWORD_FILE /var/lib/nanoclaw/secrets/central-db-password
upsert NANOCLAW_DB_MIGRATE_PASSWORD_FILE /var/lib/nanoclaw/secrets/central-db-migrate-password
upsert NANOCO_GATEWAY_CA /run/nanoclaw/pki/gateway-server-ca.pem
upsert NANOCO_DEPLOYMENT_CERT /run/nanoclaw/pki/deployment-client.pem
upsert NANOCO_DEPLOYMENT_KEY /run/nanoclaw/pki/deployment-client-key.pem
upsert NANOCO_PROXY_CA /run/nanoclaw/pki/proxy-ca.pem
upsert NANOCO_STATELESS_K8S_HOST 1
upsert NANOCO_MATERIALIZER_IMAGE "$materializer_ref"
upsert NANOCO_COMPOSER_DB_SECRET nanoclaw-composer-db
upsert NANOCO_WORKSPACE_CONTROLLER_URL "http://nanoclaw-workspace-controller.$namespace.svc.cluster.local:8787"
upsert NANOCO_WORKSPACE_CONTROLLER_TOKEN_FILE /run/nanoclaw/workspace-controller/token
upsert NANOCO_WORKSPACE_HOST_ROOT /var/lib/nanoco/workspaces
upsert NANOCO_HOST_AUDIT_URL "https://governance-host-audit.$namespace.svc.cluster.local:$host_audit_port/api/host-audit/v1/events"
upsert NANOCO_HOST_AUDIT_TLS_CERT /etc/nanoclaw/host-audit/host-client.pem
upsert NANOCO_HOST_AUDIT_TLS_KEY /etc/nanoclaw/host-audit/host-client-key.pem
upsert NANOCO_HOST_AUDIT_TLS_CA /etc/nanoclaw/host-audit/governance-server-ca.pem
upsert NANOCO_HOST_AUDIT_PSEUDONYM_KEY_FILE /run/nanoclaw/secrets/host-audit-pseudonym.key
upsert NANOCO_GATEWAY_CONTROL_URL "https://gateway-control.$namespace.svc.cluster.local:9444"
upsert NANOCO_GATEWAY_CLAIM_URL "https://gateway-claim.$namespace.svc.cluster.local:9446"
upsert NANOCO_GATEWAY_ADDRESS "gateway-session.$namespace.svc.cluster.local:9443"
upsert CONTAINER_IMAGE "$agent_image"
[[ -z "$slack_api_url" ]] || upsert SLACK_API_URL "$slack_api_url"
grep -qx "NANOCO_DEPLOYMENT_ID=$deployment_id" "$runtime_env" || fail 'rendered NANOCO_DEPLOYMENT_ID disagrees with the deployment profile'

env_value() {
  awk -v key="$1" 'index($0, key "=") == 1 {sub("^" key "=", ""); print; exit}' "$runtime_env"
}
workspace_bucket="$(env_value NANOCLAW_WORKSPACE_S3_BUCKET)"
workspace_endpoint="$(env_value NANOCLAW_WORKSPACE_S3_ENDPOINT)"
workspace_prefix="$(env_value NANOCLAW_WORKSPACE_S3_PREFIX)"
workspace_region="$(env_value NANOCLAW_WORKSPACE_S3_REGION)"
workspace_role_arn_template="$(env_value NANOCO_WORKSPACE_ROLE_ARN_TEMPLATE)"
[[ "$workspace_bucket" =~ ^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$ ]] || fail 'NANOCLAW_WORKSPACE_S3_BUCKET is required'
[[ "$workspace_prefix" =~ ^[A-Za-z0-9._/-]+$ && "$workspace_prefix" != *'..'* ]] || fail 'NANOCLAW_WORKSPACE_S3_PREFIX is invalid'
[[ "$workspace_region" =~ ^[a-z]{2}(-gov)?-[a-z]+-[0-9]$ ]] || fail 'NANOCLAW_WORKSPACE_S3_REGION is invalid'
[[ "$workspace_endpoint" == "https://s3.$workspace_region.amazonaws.com" ]] || fail 'workspace S3 endpoint must match the region'
[[ -z "$workspace_role_arn_template" || "$workspace_role_arn_template" =~ ^arn:aws[a-z-]*:iam::[0-9]{12}:role/[A-Za-z0-9_+=,.@/{}-]+$ && "$workspace_role_arn_template" == *'{groupId}'* ]] || fail 'NANOCO_WORKSPACE_ROLE_ARN_TEMPLATE must be an IAM role ARN containing {groupId}'
workspace_disable_imds=0
[[ -z "$workspace_role_arn_template" ]] || workspace_disable_imds=1
awk '!/^(NANOCLAW_WORKSPACE_S3_(BUCKET|ENDPOINT|PREFIX|REGION)|NANOCO_WORKSPACE_ROLE_ARN_TEMPLATE)=/' "$runtime_env" >"$host_env"
chmod 0600 "$host_env"

if "${kube[@]}" get namespace "$agents_namespace" >/dev/null 2>&1; then
  legacy_sessions="$("${kube[@]}" -n "$agents_namespace" get pods -l "nanoclaw-install=$install_id" \
    -o 'custom-columns=NAME:.metadata.name,WORKSPACE:.metadata.labels.nanoco\.ai/workspace' --no-headers 2>/dev/null \
    | awk '$2 != "true" {print $1}')"
  [[ -z "$legacy_sessions" ]] || fail "legacy PR #312 session workspaces require an inventoried, owner-reviewed migration before rollout: $(tr '\n' ' ' <<<"$legacy_sessions")"
fi

"${kube[@]}" create namespace "$namespace" --dry-run=client -o yaml | "${kube[@]}" apply -f - >/dev/null
"${kube[@]}" create namespace "$agents_namespace" --dry-run=client -o yaml | "${kube[@]}" apply -f - >/dev/null
workspace_node="$("${kube[@]}" get nodes -o jsonpath='{.items[0].metadata.name}')"
[[ -n "$workspace_node" ]] || fail 'workspace storage needs a Kubernetes node'
operator_source_ip="$(ip -4 -o addr show dev cni0 | awk '{split($4, address, "/"); print address[1]; exit}')"
[[ "$operator_source_ip" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] || fail 'k3s cni0 has no IPv4 operator source address'
if ! "${kube[@]}" get node "$workspace_node" -o jsonpath='{.metadata.labels.nanoco\.ai/workspace-nvme}' | grep -qx true; then
  [[ "$("${kube[@]}" get nodes -o name | wc -l | tr -d ' ')" == 1 && "$workspace_node" == "$(hostname)" ]] || fail 'label verified workspace nodes with nanoco.ai/workspace-nvme=true before deployment'
  compgen -G '/dev/nvme*n1' >/dev/null || fail 'workspace node has no NVMe block device; do not place the plaintext plane on slow storage'
  "${kube[@]}" label node "$workspace_node" nanoco.ai/workspace-nvme=true --overwrite >/dev/null
fi
"${kube[@]}" -n "$namespace" create secret generic nanoclaw-host-env --from-env-file="$host_env" --dry-run=client -o yaml | "${kube[@]}" apply -f - >/dev/null
"${kube[@]}" -n "$namespace" create secret generic nanoclaw-host-dotenv --from-file=.env="$host_env" --dry-run=client -o yaml | "${kube[@]}" apply -f - >/dev/null
"${kube[@]}" -n "$namespace" create secret generic nanoclaw-host-runtime \
  --from-file=central-db-password="$secrets_dir/central-db-password" \
  --from-file=central-db-migrate-password="$secrets_dir/central-db-migrate-password" \
  --from-file=host-audit-pseudonym.key="$secrets_dir/host-audit-pseudonym.key" \
  --dry-run=client -o yaml | "${kube[@]}" apply -f - >/dev/null
"${kube[@]}" -n "$namespace" create secret generic nanoclaw-host-audit-tls \
  --from-file=host-client.pem="$ncl_pki_dir/host-client.pem" \
  --from-file=host-client-key.pem="$ncl_pki_dir/host-client-key.pem" \
  --from-file=governance-server-ca.pem="$ncl_pki_dir/governance-server-ca.pem" \
  --dry-run=client -o yaml | "${kube[@]}" apply -f - >/dev/null
"${kube[@]}" -n "$namespace" create secret generic nanoclaw-host-pki \
  --from-file=gateway-server-ca.pem="$pki_dir/gateway-server-ca.pem" \
  --from-file=deployment-client.pem="$pki_dir/deployment-client.pem" \
  --from-file=deployment-client-key.pem="$pki_dir/deployment-client-key.pem" \
  --from-file=proxy-ca.pem="$pki_dir/proxy-ca.pem" \
  --dry-run=client -o yaml | "${kube[@]}" apply -f - >/dev/null
"${kube[@]}" -n "$namespace" create secret generic nanoclaw-host-control-tls \
  --from-file=server.pem="$ncl_pki_dir/ncl-server.pem" \
  --from-file=server-key.pem="$ncl_pki_dir/ncl-server-key.pem" \
  --from-file=client-ca.pem="$ncl_pki_dir/ncl-client-ca.pem" \
  --from-file=governance-client.pem="$ncl_pki_dir/governance-ncl-client.pem" \
  --from-file=operator-client.pem="$ncl_pki_dir/operator-ncl-client.pem" \
  --dry-run=client -o yaml | "${kube[@]}" apply -f - >/dev/null
"${kube[@]}" -n "$agents_namespace" create secret generic nanoclaw-composer-db \
  --from-file=central-db-password="$secrets_dir/central-db-password" \
  --dry-run=client -o yaml | "${kube[@]}" apply -f - >/dev/null
"${kube[@]}" -n "$agents_namespace" create secret generic nanoclaw-session-public \
  --from-file=gateway-server-ca.pem="$pki_dir/gateway-server-ca.pem" \
  --from-file=proxy-ca.pem="$pki_dir/proxy-ca.pem" \
  --dry-run=client -o yaml | "${kube[@]}" apply -f - >/dev/null
if ! "${kube[@]}" -n "$namespace" get secret nanoclaw-workspace-controller-token >/dev/null 2>&1; then
  workspace_controller_token="$(openssl rand -base64 32 | tr -d '\n')"
  "${kube[@]}" -n "$namespace" create secret generic nanoclaw-workspace-controller-token \
    --from-literal=token="$workspace_controller_token" --dry-run=client -o yaml | "${kube[@]}" apply -f - >/dev/null
fi
"${kube[@]}" -n "$namespace" create configmap nanoclaw-workspace-storage \
  --from-literal=NANOCLAW_WORKSPACE_S3_BUCKET="$workspace_bucket" \
  --from-literal=NANOCLAW_WORKSPACE_S3_ENDPOINT="$workspace_endpoint" \
  --from-literal=NANOCLAW_WORKSPACE_S3_PREFIX="$workspace_prefix" \
  --from-literal=NANOCLAW_WORKSPACE_S3_REGION="$workspace_region" \
  --dry-run=client -o yaml | "${kube[@]}" apply -f - >/dev/null

current_replicas="$("${kube[@]}" -n "$namespace" get deploy nanoclaw-host -o jsonpath='{.spec.replicas}' 2>/dev/null || printf 0)"
[[ "$current_replicas" =~ ^[0-9]+$ ]] || current_replicas=0
if ((current_replicas > 0)) && [[ -z "$allow_rollout" ]]; then
  fail 'Host is already in Kubernetes; rerun with --allow-rollout'
fi
if ((current_replicas > 0)) && systemctl --user is-active --quiet "$host_unit"; then
  fail "TWO HOSTS: deploy/nanoclaw-host and $host_unit are active"
fi

cat >"$manifest" <<EOF
apiVersion: v1
kind: ServiceAccount
metadata:
  name: nanoclaw-host
  namespace: $namespace
  labels: {app.kubernetes.io/name: nanoclaw-host, app.kubernetes.io/managed-by: nanoco-recipes}
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: nanoclaw-session-driver
  namespace: $agents_namespace
rules:
  - apiGroups: [""]
    resources: ["pods"]
    verbs: ["get", "list", "watch", "create", "delete"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: nanoclaw-session-driver
  namespace: $agents_namespace
subjects:
  - kind: ServiceAccount
    name: nanoclaw-host
    namespace: $namespace
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: Role
  name: nanoclaw-session-driver
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: nanoclaw-runtimeclass-reader-$install_id
rules:
  - apiGroups: ["node.k8s.io"]
    resources: ["runtimeclasses"]
    verbs: ["get"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: nanoclaw-runtimeclass-reader-$install_id
subjects:
  - kind: ServiceAccount
    name: nanoclaw-host
    namespace: $namespace
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: nanoclaw-runtimeclass-reader-$install_id
---
apiVersion: v1
kind: ServiceAccount
metadata:
  name: nanoclaw-workspace-controller
  namespace: $namespace
  labels: {app.kubernetes.io/name: nanoclaw-workspace-controller, app.kubernetes.io/managed-by: nanoco-recipes}
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: nanoclaw-workspace-controller
  namespace: $namespace
rules:
  - apiGroups: [""]
    resources: ["pods", "services", "serviceaccounts", "secrets"]
    verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]
  - apiGroups: ["coordination.k8s.io"]
    resources: ["leases"]
    verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: nanoclaw-workspace-controller
  namespace: $namespace
subjects:
  - kind: ServiceAccount
    name: nanoclaw-workspace-controller
    namespace: $namespace
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: Role
  name: nanoclaw-workspace-controller
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: nanoclaw-workspace-session-finalizer
  namespace: $agents_namespace
rules:
  - apiGroups: [""]
    resources: ["pods"]
    verbs: ["get", "list", "watch", "patch", "delete"]
  - apiGroups: [""]
    resources: ["pods/finalizers"]
    verbs: ["update", "patch"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: nanoclaw-workspace-session-finalizer
  namespace: $agents_namespace
subjects:
  - kind: ServiceAccount
    name: nanoclaw-workspace-controller
    namespace: $namespace
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: Role
  name: nanoclaw-workspace-session-finalizer
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: nanoclaw-workspace-node-reader-$install_id
rules:
  - apiGroups: [""]
    resources: ["nodes"]
    verbs: ["get", "list", "watch"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: nanoclaw-workspace-node-reader-$install_id
subjects:
  - kind: ServiceAccount
    name: nanoclaw-workspace-controller
    namespace: $namespace
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: nanoclaw-workspace-node-reader-$install_id
---
apiVersion: v1
kind: Service
metadata:
  name: nanoclaw-workspace-controller
  namespace: $namespace
  labels: {app.kubernetes.io/name: nanoclaw-workspace-controller, app.kubernetes.io/managed-by: nanoco-recipes}
spec:
  type: ClusterIP
  selector: {app.kubernetes.io/name: nanoclaw-workspace-controller}
  ports:
    - {name: api, port: 8787, targetPort: api, protocol: TCP}
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: nanoclaw-workspace-controller
  namespace: $namespace
spec:
  podSelector:
    matchLabels: {app.kubernetes.io/name: nanoclaw-workspace-controller}
  policyTypes: [Ingress]
  ingress:
    - from:
        - podSelector:
            matchLabels: {app.kubernetes.io/name: nanoclaw-host}
      ports:
        - {protocol: TCP, port: 8787}
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: nanoclaw-workspace-custodian
  namespace: $namespace
spec:
  podSelector:
    matchLabels: {app.kubernetes.io/name: nanoclaw-workspace-custodian}
  policyTypes: [Ingress]
  ingress:
    - from:
        - podSelector:
            matchLabels: {app.kubernetes.io/name: nanoclaw-workspace-controller}
      ports:
        - {protocol: TCP, port: 8788}
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: nanoclaw-workspace-controller
  namespace: $namespace
  labels: {app.kubernetes.io/name: nanoclaw-workspace-controller, app.kubernetes.io/managed-by: nanoco-recipes}
  annotations:
    nanoco.ai/build-id: "$build_id"
    nanoco.ai/source-sha256: "$source_digest"
spec:
  replicas: 1
  revisionHistoryLimit: 2
  strategy: {type: Recreate}
  selector:
    matchLabels: {app.kubernetes.io/name: nanoclaw-workspace-controller}
  template:
    metadata:
      labels: {app.kubernetes.io/name: nanoclaw-workspace-controller, app.kubernetes.io/managed-by: nanoco-recipes}
    spec:
      serviceAccountName: nanoclaw-workspace-controller
      automountServiceAccountToken: true
      enableServiceLinks: false
      securityContext:
        runAsUser: 10001
        runAsGroup: 10001
        runAsNonRoot: true
        fsGroup: 10001
        seccompProfile: {type: RuntimeDefault}
      containers:
        - name: controller
          image: $image_ref
          imagePullPolicy: Never
          command: ["node", "/opt/nanoclaw/dist/storage/workspace-controller.js"]
          env:
            - {name: NANOCO_WORKSPACE_NAMESPACE, value: "$namespace"}
            - {name: NANOCLAW_POD_NAMESPACE, value: "$agents_namespace"}
            - {name: NANOCO_WORKSPACE_HOST_ROOT, value: /var/lib/nanoco/workspaces}
            - {name: NANOCO_WORKSPACE_IMAGE, value: "$image_ref"}
            - {name: NANOCO_WORKSPACE_CONTROLLER_TOKEN_FILE, value: /run/nanoco/controller/token}
            - {name: NANOCO_WORKSPACE_RUN_AS_UID, value: "10001"}
            - {name: NANOCO_WORKSPACE_RUN_AS_GID, value: "10001"}
            - {name: NANOCO_WORKSPACE_ROLE_ARN_TEMPLATE, value: "$workspace_role_arn_template"}
            - {name: NANOCO_WORKSPACE_DISABLE_IMDS, value: "$workspace_disable_imds"}
            - {name: NANOCO_WORKSPACE_RECONCILE_MS, value: "5000"}
            - {name: AWS_EC2_METADATA_DISABLED, value: "true"}
            - {name: HOME, value: /tmp}
          ports:
            - {name: api, containerPort: 8787, protocol: TCP}
          readinessProbe:
            httpGet: {path: /ready, port: api}
            periodSeconds: 5
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            capabilities: {drop: [ALL]}
          resources:
            requests: {cpu: 50m, memory: 64Mi}
            limits: {memory: 256Mi}
          volumeMounts:
            - {name: controller-token, mountPath: /run/nanoco/controller, readOnly: true}
            - {name: tmp, mountPath: /tmp}
      volumes:
        - name: controller-token
          secret: {secretName: nanoclaw-workspace-controller-token, defaultMode: 0440}
        - name: tmp
          emptyDir: {medium: Memory, sizeLimit: 32Mi}
---
apiVersion: v1
kind: Service
metadata:
  name: nanoclaw-channel-relay
  namespace: $namespace
  labels: {app.kubernetes.io/name: nanoclaw-host, app.kubernetes.io/managed-by: nanoco-recipes}
spec:
  type: ClusterIP
  selector: {app.kubernetes.io/name: nanoclaw-host}
  ports:
    - {name: webhook, port: 3000, targetPort: webhook, protocol: TCP}
---
apiVersion: v1
kind: Service
metadata:
  name: nanoclaw-host-control
  namespace: $namespace
  labels: {app.kubernetes.io/name: nanoclaw-host, app.kubernetes.io/managed-by: nanoco-recipes}
spec:
  type: ClusterIP
  selector: {app.kubernetes.io/name: nanoclaw-host}
  ports:
    - {name: https, port: $ncl_control_port, targetPort: ncl-control, protocol: TCP}
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: nanoclaw-host-control
  namespace: $namespace
  labels: {app.kubernetes.io/name: nanoclaw-host, app.kubernetes.io/managed-by: nanoco-recipes}
spec:
  podSelector:
    matchLabels: {app.kubernetes.io/name: nanoclaw-host}
  policyTypes: [Ingress]
  ingress:
    - from:
        - podSelector:
            matchLabels: {app.kubernetes.io/name: governance}
        - podSelector:
            matchLabels: {app.kubernetes.io/name: nanoco-operator}
        # The single-node k3s deploy controller runs on the trusted node, not
        # in a pod. Admit exactly that InternalIP; every request still needs an
        # enrolled operator mTLS leaf. Kata agent Pod IPs are not covered.
        - ipBlock: {cidr: "$operator_source_ip/32"}
      ports:
        - {protocol: TCP, port: $ncl_control_port}
    - from:
        - namespaceSelector:
            matchLabels: {kubernetes.io/metadata.name: mocks}
          podSelector:
            matchLabels: {app.kubernetes.io/name: backlot}
      ports:
        - {protocol: TCP, port: 3000}
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: nanoclaw-host
  namespace: $namespace
  labels: {app.kubernetes.io/name: nanoclaw-host, app.kubernetes.io/managed-by: nanoco-recipes}
  annotations:
    nanoco.ai/build-id: "$build_id"
    nanoco.ai/source-sha256: "$source_digest"
    nanoco.ai/image-id: "$image_id"
spec:
  replicas: $current_replicas
  revisionHistoryLimit: 2
  strategy:
    type: RollingUpdate
    rollingUpdate: {maxSurge: 0, maxUnavailable: 1}
  selector:
    matchLabels: {app.kubernetes.io/name: nanoclaw-host}
  template:
    metadata:
      labels: {app.kubernetes.io/name: nanoclaw-host, app.kubernetes.io/managed-by: nanoco-recipes}
      annotations:
        nanoco.ai/source-sha256: "$source_digest"
        nanoco.ai/image-id: "$image_id"
    spec:
      serviceAccountName: nanoclaw-host
      automountServiceAccountToken: true
      enableServiceLinks: false
      terminationGracePeriodSeconds: 30
      securityContext:
        runAsUser: 10001
        runAsGroup: 10001
        runAsNonRoot: true
        fsGroup: 10001
        fsGroupChangePolicy: OnRootMismatch
        seccompProfile: {type: RuntimeDefault}
      containers:
        - name: nanoclaw-host
          image: $image_ref
          imagePullPolicy: Never
          envFrom:
            - secretRef: {name: nanoclaw-host-env}
          env:
            - {name: HOME, value: /tmp}
            - {name: AWS_EC2_METADATA_DISABLED, value: "false"}
            - {name: NANOCLAW_NCL_CONTROL_BIND, value: "0.0.0.0"}
            - {name: NANOCLAW_NCL_CONTROL_PORT, value: "$ncl_control_port"}
            - {name: NANOCLAW_NCL_CONTROL_TLS_CERT, value: /etc/nanoclaw/ncl-control/server.pem}
            - {name: NANOCLAW_NCL_CONTROL_TLS_KEY, value: /etc/nanoclaw/ncl-control/server-key.pem}
            - {name: NANOCLAW_NCL_CONTROL_CLIENT_CA, value: /etc/nanoclaw/ncl-control/client-ca.pem}
            - {name: NANOCLAW_NCL_CONTROL_ALLOWED_CLIENT_CERTS, value: "/etc/nanoclaw/ncl-control/governance-client.pem,/etc/nanoclaw/ncl-control/operator-client.pem"}
          ports:
            - {name: ncl-control, containerPort: $ncl_control_port, protocol: TCP}
            - {name: webhook, containerPort: 3000, protocol: TCP}
          readinessProbe:
            tcpSocket: {port: ncl-control}
            periodSeconds: 10
            timeoutSeconds: 3
            failureThreshold: 3
          resources:
            requests: {cpu: 100m, memory: 256Mi}
            limits: {memory: 1Gi}
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            capabilities: {drop: [ALL]}
          volumeMounts:
            - {name: runtime, mountPath: /var/lib/nanoclaw}
            - {name: runtime-secrets, mountPath: /run/nanoclaw/secrets, readOnly: true}
            - {name: deployment-pki, mountPath: /run/nanoclaw/pki, readOnly: true}
            - {name: host-audit-tls, mountPath: /etc/nanoclaw/host-audit, readOnly: true}
            - {name: ncl-control-tls, mountPath: /etc/nanoclaw/ncl-control, readOnly: true}
            - {name: workspace-controller-token, mountPath: /run/nanoclaw/workspace-controller, readOnly: true}
            - {name: runtime-dotenv, mountPath: /opt/nanoclaw/.env, subPath: .env, readOnly: true}
            - {name: tmp, mountPath: /tmp}
      volumes:
        - name: runtime
          emptyDir: {medium: Memory, sizeLimit: 512Mi}
        - name: runtime-secrets
          secret: {secretName: nanoclaw-host-runtime, defaultMode: 0440}
        - name: deployment-pki
          secret: {secretName: nanoclaw-host-pki, defaultMode: 0440}
        - name: host-audit-tls
          secret: {secretName: nanoclaw-host-audit-tls, defaultMode: 0440}
        - name: ncl-control-tls
          secret: {secretName: nanoclaw-host-control-tls, defaultMode: 0440}
        - name: workspace-controller-token
          secret: {secretName: nanoclaw-workspace-controller-token, defaultMode: 0440}
        - name: runtime-dotenv
          secret: {secretName: nanoclaw-host-dotenv, defaultMode: 0440}
        - name: tmp
          emptyDir: {medium: Memory, sizeLimit: 256Mi}
EOF

"${kube[@]}" apply --dry-run=server -f "$manifest" >/dev/null
"${kube[@]}" apply -f "$manifest" >/dev/null
if [[ -z "$defer_rollout_wait" ]]; then
  "${kube[@]}" -n "$namespace" rollout status deployment/nanoclaw-workspace-controller --timeout=300s
  if ((current_replicas > 0)); then
    "${kube[@]}" -n "$namespace" rollout status deployment/nanoclaw-host --timeout=300s
  fi
fi
printf 'host-image=%s\n' "$image_ref"
printf 'materializer-image=%s\n' "$materializer_ref"
