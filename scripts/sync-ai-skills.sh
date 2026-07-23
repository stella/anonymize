#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

optional=false
args=()
for arg in "$@"; do
  if [[ "$arg" == "--optional" ]]; then
    optional=true
  else
    args+=("$arg")
  fi
done

if [[ ! -f "$REPO_ROOT/.ai/shared/scripts/sync-ai-skills.sh" ]]; then
  if [[ "$optional" == "true" ]]; then
    echo "warning: .ai/shared submodule is not initialized; skipping AI instruction sync check" >&2
    echo "  fix: git submodule update --init" >&2
    exit 0
  fi
  echo "error: .ai/shared submodule is not initialized." >&2
  echo "Run: git submodule update --init" >&2
  exit 1
fi

if [[ "${#args[@]}" -eq 0 ]]; then
  bash "$REPO_ROOT/.ai/shared/scripts/sync-ai-skills.sh" "$REPO_ROOT"
else
  bash "$REPO_ROOT/.ai/shared/scripts/sync-ai-skills.sh" "${args[@]}" "$REPO_ROOT"
fi
