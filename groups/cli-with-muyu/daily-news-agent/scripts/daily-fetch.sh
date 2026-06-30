#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
exec ./node_modules/.bin/tsx lib/run-fetch.ts
