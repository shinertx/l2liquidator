# Base Router Allow-List Playbook

> **Status – 2025-10-05:** Both Aerodrome and Uniswap routers remain unapproved on the Base liquidator. Operators should batch the two Safe transactions below before the next live window to clear the `router-allow-failed` errors.

The Base liquidator contract at `0xEd4dB6eA97B7F9A877f529db65976702083CA64B` only accepts bundles from
routers that the owner has explicitly approved.  When we wire up new venues, the automatic
`scripts/allow_routers.sh base` helper can discover the addresses, but it cannot broadcast the
transaction unless it is run with the Safe owner key – the on-chain function reverts with `!owner`
otherwise (see `router-allow-failed` entries in `logs/live.log`).

## Routers We Must Keep Whitelisted

| Alias        | Purpose            | Address                                      |
|--------------|--------------------|----------------------------------------------|
| `BASE_UNIV3_ROUTER` | Uniswap V3 SwapRouter02 | `0x2626664c2603336E57B271c5C0b26F421741e481` |
| `BASE_AERODROME_ROUTER` | Aerodrome (Solidly v2) | `0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43` |

The Aerodrome router must use the canonical checksum shown above; otherwise viem will reject it
before the call is sent.

## Safe Transaction Checklist

1. **Load the Safe** that owns the Base liquidator.
2. **Prepare two transactions** calling `setRouterAllowed(address,bool)` on
   `0xEd4dB6eA97B7F9A877f529db65976702083CA64B`:
   - `(0x2626664c2603336E57B271c5C0b26F421741e481, true)`
   - `(0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43, true)`
3. **Execute and confirm** both transactions.
4. **Verify**: run `scripts/allow_routers.sh base --liquidator 0xEd4dB6eA97B7F9A877f529db65976702083CA64B`
   from an operator machine – it should now emit only `router-allow-ok` entries and the orchestrator
   logs should stop reporting `router-allow-failed`.

Keep this procedure handy whenever we add another Base venue; the on-chain gate will block us until
the Safe approves the new router.
