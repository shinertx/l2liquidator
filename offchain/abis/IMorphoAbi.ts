export const IMorphoAbi = [
  {
    inputs: [
      {
        components: [
          {
            internalType: "address",
            name: "loanToken",
            type: "address",
          },
          {
            internalType: "address",
            name: "collateralToken",
            type: "address",
          },
          {
            internalType: "address",
            name: "oracle",
            type: "address",
          },
          {
            internalType: "address",
            name: "irm",
            type: "address",
          },
          {
            internalType: "uint256",
            name: "lltv",
            type: "uint256",
          },
        ],
        internalType: "struct MarketParams",
        name: "marketParams",
        type: "tuple",
      },
      {
        internalType: "address",
        name: "borrower",
        type: "address",
      },
      {
        internalType: "uint256",
        name: "seizedAssets",
        type: "uint256",
      },
      {
        internalType: "address",
        name: "onBehalf",
        type: "address",
      },
    ],
    name: "liquidate",
    outputs: [
      {
        internalType: "uint256",
        name: "repaidAssets",
        type: "uint256",
      },
      {
        internalType: "uint256",
        name: "seizedCollateral",
        type: "uint256",
      },
    ],
    stateMutability: "nonpayable",
    type: "function",
  },
] as const;
