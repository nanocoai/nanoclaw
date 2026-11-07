#!/bin/bash
# Test plan for the add-container-image-variants skill.
#
# IMPORTANT: This script tests the POST-APPLICATION state of the skill.
# Run it AFTER applying the skill to a project:
#   npx tsx scripts/apply-skill.ts .claude/skills/add-container-image-variants
#
# The NanoClaw CI (scripts/run-ci-tests.ts) does this automatically in a
# temp directory before invoking this script.
#
# Covers:
#   1. TypeScript build passes after skill is applied
#   2. Build script produces both default and variant images
#   3. Variant image is actually distinct (contains the marker we added)
#   4. Code: per-group image selection present in container-runner.ts
#   5. Code: default fallback and types.ts field present
#
# Usage:
#   ./test-plan.sh
#   CONTAINER_RUNTIME=podman ./test-plan.sh

set -euo pipefail

CONTAINER_RUNTIME="${CONTAINER_RUNTIME:-docker}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
VARIANT_NAME="test-variant-$$"
VARIANT_IMAGE="nanoclaw-agent-${VARIANT_NAME}:latest"
VARIANT_DIR="${PROJECT_ROOT}/container/${VARIANT_NAME}"
PASS=0
FAIL=0

cd "${PROJECT_ROOT}"

# ── helpers ──────────────────────────────────────────────────────────────────

pass() { echo "  ✓ $1"; PASS=$((PASS + 1)); }
fail() { echo "  ✗ $1"; FAIL=$((FAIL + 1)); }
section() { echo ""; echo "── $1"; }

cleanup() {
  rm -rf "${VARIANT_DIR}" 2>/dev/null || true
  ${CONTAINER_RUNTIME} rmi "${VARIANT_IMAGE}" 2>/dev/null || true
}
trap cleanup EXIT

# ── preflight: verify skill is applied ───────────────────────────────────────

if ! grep -q "containerConfig?.image" src/container-runner.ts 2>/dev/null; then
  echo ""
  echo "ERROR: Skill not applied — src/container-runner.ts does not contain the"
  echo "       per-group image selection code."
  echo ""
  echo "Apply the skill first:"
  echo "  npx tsx scripts/apply-skill.ts .claude/skills/add-container-image-variants"
  echo ""
  exit 1
fi

if ! grep -q "for dir in" container/build.sh 2>/dev/null; then
  echo ""
  echo "ERROR: Skill not applied — container/build.sh does not contain multi-image"
  echo "       variant discovery logic."
  echo ""
  echo "Apply the skill first:"
  echo "  npx tsx scripts/apply-skill.ts .claude/skills/add-container-image-variants"
  echo ""
  exit 1
fi

# ── 1. TypeScript build ───────────────────────────────────────────────────────

section "1. TypeScript build"

if npm run build --silent 2>&1; then
  pass "npm run build succeeded"
else
  fail "npm run build failed"
fi

# ── 2. Multi-image build ──────────────────────────────────────────────────────

section "2. Multi-image build"

# Create a minimal variant Dockerfile with a distinctive marker
mkdir -p "${VARIANT_DIR}"
cat > "${VARIANT_DIR}/Dockerfile" <<'DOCKERFILE'
FROM nanoclaw-agent:latest
# Test variant — adds a marker file for test verification
RUN touch /tmp/nanoclaw-variant-marker
DOCKERFILE

BUILD_OUTPUT=$(CONTAINER_RUNTIME="${CONTAINER_RUNTIME}" ./container/build.sh 2>&1)

if echo "${BUILD_OUTPUT}" | grep -q "Built nanoclaw-agent:latest"; then
  pass "default image built"
else
  fail "default image not built"
fi

if echo "${BUILD_OUTPUT}" | grep -q "Built ${VARIANT_IMAGE}"; then
  pass "variant image built"
else
  fail "variant image not built — check build.sh variant discovery"
fi

if ${CONTAINER_RUNTIME} image inspect nanoclaw-agent:latest >/dev/null 2>&1; then
  pass "nanoclaw-agent:latest exists in runtime"
else
  fail "nanoclaw-agent:latest not found in runtime"
fi

if ${CONTAINER_RUNTIME} image inspect "${VARIANT_IMAGE}" >/dev/null 2>&1; then
  pass "${VARIANT_IMAGE} exists in runtime"
else
  fail "${VARIANT_IMAGE} not found in runtime"
fi

# ── 3. Variant image is distinct ─────────────────────────────────────────────

section "3. Variant image is distinct"

if ${CONTAINER_RUNTIME} run --rm --entrypoint /bin/sh "${VARIANT_IMAGE}" \
    -c "test -f /tmp/nanoclaw-variant-marker && echo found" 2>/dev/null | grep -q found; then
  pass "variant image contains marker (correct image ran)"
else
  fail "variant image missing marker — image may not have been built correctly"
fi

if ${CONTAINER_RUNTIME} run --rm --entrypoint /bin/sh nanoclaw-agent:latest \
    -c "test -f /tmp/nanoclaw-variant-marker && echo found || echo absent" 2>/dev/null | grep -q absent; then
  pass "default image does not contain variant marker"
else
  fail "default image unexpectedly contains variant marker"
fi

# ── 4. Code: per-group image selection ───────────────────────────────────────

section "4. Code: per-group image selection"

if grep -q "containerConfig?.image" src/container-runner.ts; then
  pass "container-runner.ts uses containerConfig?.image"
else
  fail "container-runner.ts missing containerConfig?.image"
fi

if grep -q "containerConfig?.image || CONTAINER_IMAGE" src/container-runner.ts; then
  pass "container-runner.ts falls back to CONTAINER_IMAGE"
else
  fail "container-runner.ts missing CONTAINER_IMAGE fallback"
fi

# ── 5. Code: types.ts ────────────────────────────────────────────────────────

section "5. Code: ContainerConfig.image field"

if grep -q "image\?:.*string" src/types.ts; then
  pass "types.ts declares ContainerConfig.image"
else
  fail "types.ts missing image field in ContainerConfig"
fi

# ── summary ───────────────────────────────────────────────────────────────────

echo ""
echo "────────────────────────────────"
echo "  Results: ${PASS} passed, ${FAIL} failed"
echo "────────────────────────────────"

[[ ${FAIL} -eq 0 ]]
