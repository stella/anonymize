#!/usr/bin/env bash
set -euo pipefail

if [[ ! -f ".ai/shared/scripts/sync-ai-skills.sh" ]]; then
  echo "error: .ai/shared submodule is not initialized." >&2
  echo "Run: git submodule update --init" >&2
  exit 1
fi

bash .ai/shared/scripts/sync-ai-skills.sh "$@" .
