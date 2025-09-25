#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="${SCRIPT_DIR}/.."
# Prefer liquidator/.env then repo root .env
if [[ -f "${ROOT}/.env" ]]; then
  set -a; source "${ROOT}/.env"; set +a
elif [[ -f "${ROOT}/../.env" ]]; then
  set -a; source "${ROOT}/../.env"; set +a
fi
exec npm run dev
