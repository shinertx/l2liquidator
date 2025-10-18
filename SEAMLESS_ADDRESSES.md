# Seamless Protocol Addresses (Base Chain - 8453)

## Core Contracts
- **Pool:** 0x8F44Fd754285aa6A2b8B9B97739B79746e0475a7
- **PoolAddressProvider:** 0x0E02EB705be325407707662C6f6d3466E939f3a0
- **Oracle:** 0x4DEDf3b5554F0e652b7F506e5Cc46Ed3B19D6eBE
- **ProtocolDataProvider:** 0x2A0979257105834789bC6b9fa1B00BBa1b4Ec93C

## Assets (Base)
- **WETH:** 0x4200000000000000000000000000000000000006
- **USDC:** 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
- **cbETH:** 0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22
- **wstETH:** 0xc1CBa3fCea344f92D9239c08C0568f6F2F0ee452

## Subgraph
- **Base Mainnet:** https://api.goldsky.com/api/public/project_clsk1wzatdsls01wchl2e4n0y/subgraphs/seamless-mainnet/prod/gn

## Documentation
- Docs: https://docs.seamlessprotocol.com/
- GitHub: https://github.com/seamless-protocol

## Liquidation Parameters (Same as Aave v3)
- liquidationCall(collateralAsset, debtAsset, user, debtToCover, receiveAToken)
- Flash loan: flashLoan(receiverAddress, assets, amounts, modes, onBehalfOf, params, referralCode)
- Bonus: 5-10% depending on asset (read from ProtocolDataProvider)
