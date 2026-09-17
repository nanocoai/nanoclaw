#!/usr/bin/env bash
set -euo pipefail

mode=${1:-}
root=${2:-}
source_file=${3:-}
group_ids=${4:-}
skill_dir_name=nanoclaw-zapier-tools
owner_line='  owner: add-zapier-tool'

if [[ -z "$mode" || -z "$root" ]]; then
  echo "usage: manage-zapier-skill.sh <install|remove> <root> [source] [comma-separated-group-ids]" >&2
  exit 2
fi

install_one() {
  local group_id=$1
  local target="$root/data/v2-sessions/$group_id/.claude-shared/skills/$skill_dir_name"
  if [[ -e "$target/SKILL.md" ]] && ! grep -qxF "$owner_line" "$target/SKILL.md"; then
    echo "refusing to overwrite unowned group skill: $target/SKILL.md" >&2
    return 1
  fi
  mkdir -p "$target"
  local staged
  staged=$(mktemp "$target/.SKILL.md.XXXXXX")
  cp "$source_file" "$staged"
  chmod 0644 "$staged"
  mv "$staged" "$target/SKILL.md"
}

case "$mode" in
  install)
    [[ -f "$source_file" ]] || { echo "bundled Zapier runtime skill is missing" >&2; exit 1; }
    IFS=',' read -r -a groups <<< "$group_ids"
    [[ ${#groups[@]} -gt 0 && -n "${groups[0]}" ]] || { echo "no agent groups selected" >&2; exit 1; }
    for group_id in "${groups[@]}"; do
      [[ "$group_id" =~ ^ag-[A-Za-z0-9-]+$ ]] || { echo "invalid agent group id: $group_id" >&2; exit 1; }
      install_one "$group_id"
    done
    ;;
  remove)
    sessions="$root/data/v2-sessions"
    [[ -d "$sessions" ]] || exit 0
    while IFS= read -r -d '' file; do
      if grep -qxF "$owner_line" "$file"; then
        rm -f "$file"
        rmdir "$(dirname "$file")" 2>/dev/null || true
      else
        echo "leaving unowned group skill untouched: $file" >&2
      fi
    done < <(find "$sessions" -type f -path "*/skills/$skill_dir_name/SKILL.md" -print0)
    ;;
  *)
    echo "unknown mode: $mode" >&2
    exit 2
    ;;
esac
