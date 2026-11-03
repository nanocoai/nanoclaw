#!/usr/bin/env bash
# Weekly: open an issue when the latest stable signal-cli release is newer than
# the Linux pin in setup/install-signal-cli.sh and at least 3 days old (the
# repo's release-age rule). One issue per version, found again by its exact
# title; the body carries the two lines to paste.
set -euo pipefail

INSTALLER=${1:-setup/install-signal-cli.sh}
REPO=${GITHUB_REPOSITORY:?}
MIN_AGE=$((3 * 24 * 3600))
# Upstream also tags four-part releases such as v0.14.4.1.
VERSION_RE='^[0-9]+(\.[0-9]+){2,3}$'

current=$(sed -n 's/^VERSION="\(.*\)"$/\1/p' "$INSTALLER")
if ! [[ "$current" =~ $VERSION_RE ]]; then
  echo "::error file=${INSTALLER}::expected one VERSION=\"x.y.z\" line" >&2
  exit 1
fi

release=$(gh api repos/AsamK/signal-cli/releases/latest)
latest=$(jq -r '.tag_name | ltrimstr("v")' <<<"$release")
if ! [[ "$latest" =~ $VERSION_RE ]]; then
  echo "::error::unexpected signal-cli release tag" >&2
  exit 1
fi

newer=$(jq -rn --arg a "$latest" --arg b "$current" '($a | split(".") | map(tonumber)) > ($b | split(".") | map(tonumber))')
if [[ "$newer" != true ]]; then
  echo "signal-cli ${current} is current (latest stable: ${latest})"
  exit 0
fi

asset="signal-cli-${latest}-Linux-native.tar.gz"
# Age from the later of publish and upload: an asset can be replaced after release.
age=$(jq -r --arg name "$asset" \
  'now - ([.published_at] + [.assets[] | select(.name == $name) | .updated_at // empty] | map(fromdateiso8601) | max) | floor' \
  <<<"$release")
if ((age < MIN_AGE)); then
  echo "signal-cli ${latest} is under 3 days old; a later run picks it up"
  exit 0
fi

digest=$(jq -r --arg name "$asset" '.assets[] | select(.name == $name) | .digest // empty' <<<"$release")
if ! [[ "$digest" =~ ^sha256:[0-9a-f]{64}$ ]]; then
  echo "::error::GitHub has no digest for ${asset} in v${latest}" >&2
  exit 1
fi

title="signal-cli ${latest}: update the Linux pin"
search=$(gh api -X GET search/issues -f per_page=100 -f q="repo:${REPO} is:issue in:title \"${title}\"")
if [[ $(jq -r '.incomplete_results or .total_count > (.items | length)' <<<"$search") != false ]]; then
  echo "::error::issue search came back incomplete; not risking a duplicate" >&2
  exit 1
fi
if [[ $(jq --arg t "$title" '[.items[] | select(.title == $t)] | length' <<<"$search") != 0 ]]; then
  echo "an issue for signal-cli ${latest} already exists"
  exit 0
fi

gh issue create --repo "$REPO" --title "$title" --body-file - <<EOF
signal-cli [${latest}](https://github.com/AsamK/signal-cli/releases/tag/v${latest}) is out. The Linux pin in \`${INSTALLER}\` is ${current}, and upstream warns that releases older than three months may stop working.

Replace these two lines in \`${INSTALLER}\`:

\`\`\`sh
VERSION="${latest}"
SHA256="${digest#sha256:}"
\`\`\`

\`SHA256\` is GitHub's digest of \`${asset}\`; CI checks it again on the pull request. macOS installs come from Homebrew and are not pinned.
EOF
