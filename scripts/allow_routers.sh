#!/usr/bin/env bash
set -euo pipefail

# Allow-list routers for a given chain (arb|op|polygon|base)
# Requires .env and LIQUIDATOR address exported or provided via --liquidator

usage() { echo "Usage: $0 <arb|op|polygon|base> --liquidator 0x..." >&2; exit 1; }

if [ $# -lt 2 ]; then usage; fi

CHAIN="$1"; shift
LIQ=""
while [ $# -gt 0 ]; do
  case "$1" in
    --liquidator)
      LIQ="$2"; shift 2 ;;
    *) usage ;;
  esac
done

if [ -z "$LIQ" ]; then usage; fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
set -a
if [ -f "$ROOT_DIR/.env" ]; then source "$ROOT_DIR/.env"; fi
set +a

case "$CHAIN" in
  arb)
    RPC="${RPC_ARB:-}"
    PRIVATE_KEY_VAL="${WALLET_PK_ARB:-}"
    export UNIV3_ROUTER="${ARB_UNIV3_ROUTER:-}"
    export SECONDARY_ROUTER1="${ARB_CAMELOT_ROUTER:-}"
    ;;
  op)
    RPC="${RPC_OP:-}"
    PRIVATE_KEY_VAL="${WALLET_PK_OP:-}"
    export UNIV3_ROUTER="${OP_UNIV3_ROUTER:-}"
    export SECONDARY_ROUTER1="${OP_VELODROME_ROUTER:-}"
    ;;
  polygon)
    RPC="${RPC_POLYGON:-}"
   PRIVATE_KEY_VAL="${WALLET_PK_POLYGON:-}"
    export UNIV3_ROUTER="${POLYGON_UNIV3_ROUTER:-}"
    export SECONDARY_ROUTER1="${POLYGON_SECONDARY_ROUTER:-}"
    ;;
  eth|mainnet)
    RPC="${RPC_ETH:-}"
    PRIVATE_KEY_VAL="${WALLET_PK_ETH:-}"
    export UNIV3_ROUTER="${ETH_UNIV3_ROUTER:-0xE592427A0AEce92De3Edee1F18E0157C05861564}"
    export SECONDARY_ROUTER1="${ETH_SECONDARY_ROUTER:-}"
    ;;
  base)
    RPC="${RPC_BASE:-}"
    PRIVATE_KEY_VAL="${WALLET_PK_BASE:-}"
    export UNIV3_ROUTER="${BASE_UNIV3_ROUTER:-}"
    export SECONDARY_ROUTER1="${BASE_AERODROME_ROUTER:-}"
    ;;
  *) echo "Unsupported chain: $CHAIN (use arb|op|polygon|base)" >&2; exit 1 ;;
esac

export LIQUIDATOR="$LIQ"

if [ -z "${RPC}" ] || [ -z "${PRIVATE_KEY_VAL}" ] || [ -z "${UNIV3_ROUTER}" ]; then
  echo "Missing required env. Need RPC, WALLET_PK_*, UNIV3_ROUTER" >&2
  exit 2
fi

export PRIVATE_KEY="$PRIVATE_KEY_VAL"

pushd "$ROOT_DIR" >/dev/null
forge script script/AllowRouters.s.sol:AllowRouters \
  --rpc-url "$RPC" \
  --private-key "$PRIVATE_KEY" \
  --broadcast -vvv | tee /tmp/allow_routers_"$CHAIN".log
echo "Routers allowed on $CHAIN for $LIQ"
popd >/dev/null
