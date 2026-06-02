#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

if [[ ! -f "$REPO_ROOT/.ai/shared/scripts/sync-ai-skills.sh" ]]; then
  echo "error: .ai/shared submodule is not initialized." >&2
  echo "Run: git submodule update --init" >&2
  exit 1
fi

bash "$REPO_ROOT/.ai/shared/scripts/sync-ai-skills.sh" "$@" "$REPO_ROOT"
