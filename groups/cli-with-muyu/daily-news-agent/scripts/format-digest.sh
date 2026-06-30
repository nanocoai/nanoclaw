#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
exec ./node_modules/.bin/tsx scripts/format-digest-cli.ts
