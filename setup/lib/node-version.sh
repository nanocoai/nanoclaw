# node-version.sh — the lowest Node setup accepts on each supported line.
# Sourced by setup.sh, setup/install-node.sh and nanoclaw.sh; pure bash,
# since it runs before Node is installed.
NODE_MINIMUMS="22.23.4 24.22.1 26.12.1"
# Where NodeSource's apt package puts node, and where else a system-wide Node
# can live (n, nodejs.org installers); tests override both.
NODE_APT_DIRS="${NODE_APT_DIRS:-/usr/bin /bin}"
NODE_SYSTEM_DIRS="${NODE_SYSTEM_DIRS:-/usr/local/bin $NODE_APT_DIRS}"

# node_meets_minimum VERSION: a listed line at or above its minimum, or a
# newer release line (it passes until listed; an odd one like 27 needs the
# 23/25 treatment once it reaches end-of-life). Pre-releases never qualify.
node_meets_minimum() {
  local v="${1#v}" re='^[0-9]+\.[0-9]+\.[0-9]+$' major minor patch min min_minor min_patch newest="${NODE_MINIMUMS##* }"
  [[ $v =~ $re ]] || return 1
  IFS=. read -r major minor patch <<<"$v"
  [ "$major" -gt "${newest%%.*}" ] && return 0
  for min in $NODE_MINIMUMS; do
    [ "${min%%.*}" = "$major" ] || continue
    IFS=. read -r _ min_minor min_patch <<<"$min"
    [ "$minor" -gt "$min_minor" ] || { [ "$minor" -eq "$min_minor" ] && [ "$patch" -ge "$min_patch" ]; }
    return
  done
  return 1
}

# node_install_line VERSION: the NodeSource line install-node.sh installs. A
# listed line stays on its line and anything older gets 22; 23, 25 and
# pre-releases fail, since installing 22 over them is a downgrade apt refuses.
node_install_line() {
  local v="${1#v}" re='^[0-9]+\.[0-9]+\.[0-9]+$' min
  [[ $v =~ $re ]] || return 1
  for min in $NODE_MINIMUMS; do
    [ "${min%%.*}" = "${v%%.*}" ] && { echo "${v%%.*}"; return; }
  done
  [ "${v%%.*}" -lt 22 ] && { echo 22; return; }
  return 1
}

node_line_minimum() {
  local min
  for min in $NODE_MINIMUMS; do
    [ "${min%%.*}" = "$1" ] && { echo "$min"; return; }
  done
  return 1
}

# node_from_apt NODE_PATH: whether NodeSource's apt package would replace it.
node_from_apt() {
  local dir
  for dir in $NODE_APT_DIRS; do
    [ "$1" = "$dir/node" ] && return 0
  done
  return 1
}

node_minimum_message() {
  echo "Node $1 at $2 does not meet the minimum (${NODE_MINIMUMS// / / })."
}

# node_use_patched: if the PATH node is below the minimum, put one that meets
# it from where install-node.sh installs (~/.local/bin, keg-only node@22, the
# system dirs) in front. PATH changes stay in the calling shell, so each script
# calls this.
node_use_patched() {
  local dir keg dirs=("$HOME/.local/bin")
  if command -v node >/dev/null 2>&1 && node_meets_minimum "$(node --version 2>/dev/null)"; then
    return 0
  fi
  if [ "$(uname -s)" = Darwin ] && command -v brew >/dev/null 2>&1; then
    keg="$(brew --prefix node@22 2>/dev/null || true)"
    if [ -n "$keg" ]; then dirs+=("$keg/bin"); fi
  fi
  for dir in "${dirs[@]}" $NODE_SYSTEM_DIRS; do
    if [ -x "$dir/node" ] && node_meets_minimum "$("$dir/node" --version 2>/dev/null)"; then
      export PATH="$dir:$PATH"
      hash -r 2>/dev/null || true
      return 0
    fi
  done
  return 1
}
