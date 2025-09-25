#!/usr/bin/env bash
set -euo pipefail

# Deploy Liquidator for a given chain (arb|op)
# Requires .env with RPC_*, WALLET_PK_*, *_AAVE_V3_PROVIDER, *_UNIV3_ROUTER, BENEFICIARY

if [ $# -ne 1 ]; then
  echo "Usage: $0 <arb|op>" >&2
  exit 1
fi

CHAIN="$1"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

set -a
if [ -f "$ROOT_DIR/.env" ]; then source "$ROOT_DIR/.env"; fi
set +a

case "$CHAIN" in
  arb)
    RPC="${RPC_ARB:-}"
    PRIVATE_KEY_VAL="${WALLET_PK_ARB:-}"
    export AAVE_V3_PROVIDER="${ARB_AAVE_V3_PROVIDER:-}"
    export UNIV3_ROUTER="${ARB_UNIV3_ROUTER:-}"
    ;;
  op)
    RPC="${RPC_OP:-}"
    PRIVATE_KEY_VAL="${WALLET_PK_OP:-}"
    export AAVE_V3_PROVIDER="${OP_AAVE_V3_PROVIDER:-}"
    export UNIV3_ROUTER="${OP_UNIV3_ROUTER:-}"
    ;;
  *)
    echo "Unsupported chain: $CHAIN (use arb|op)" >&2
    exit 1
    ;;
esac

export BENEFICIARY="${BENEFICIARY:-}"

if [ -z "${RPC}" ] || [ -z "${PRIVATE_KEY_VAL}" ] || [ -z "${AAVE_V3_PROVIDER}" ] || [ -z "${UNIV3_ROUTER}" ] || [ -z "${BENEFICIARY}" ]; then
  echo "Missing required env. Need RPC, WALLET_PK_*, *AAVE_V3_PROVIDER, *UNIV3_ROUTER, BENEFICIARY" >&2
  exit 2
fi

export PRIVATE_KEY="$PRIVATE_KEY_VAL"

pushd "$ROOT_DIR" >/dev/null
forge script script/Deploy.s.sol:Deploy \
  --rpc-url "$RPC" \
  --private-key "$PRIVATE_KEY" \
  --broadcast -vvv | tee /tmp/deploy_"$CHAIN".log

ADDR=$(grep -Eo 'Liquidator:\s*0x[0-9a-fA-F]{40}' /tmp/deploy_"$CHAIN".log | awk '{print $2}' | tail -n1 || true)
if [ -n "$ADDR" ]; then
  echo "Deployed Liquidator on $CHAIN: $ADDR"
else
  echo "Deployed, but could not parse address from logs. Check /tmp/deploy_${CHAIN}.log" >&2
fi
popd >/dev/null
