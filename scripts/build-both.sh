#!/usr/bin/env bash
#
# scripts/build-both.sh
#
# Bash wrapper around scripts/build-both.mjs that ensures the script
# runs from the repository root and forwards all arguments verbatim.
#
# Use this from Unix, macOS, or Git Bash on Windows when you want
# ergonomic shell-style invocation.
#
# Usage:
#   ./scripts/build-both.sh [options passed to build-both.mjs]

set -euo pipefail

scriptDir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repoRoot="$(cd "$scriptDir/.." && pwd)"

cd "$repoRoot"

exec node "$repoRoot/scripts/build-both.mjs" "$@"
