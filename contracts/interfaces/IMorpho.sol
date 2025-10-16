// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.24;

struct MarketParams {
    address loanToken;
    address collateralToken;
    address oracle;
    address irm;
    uint256 lltv;
}

interface IMorpho {
    function flashLoan(
        address token,
        uint256 assets,
        bytes calldata data
    ) external;

    function liquidate(
        MarketParams calldata marketParams,
        address borrower,
        uint256 repayAmount,
        uint256 repayShares,
        bytes calldata data
    ) external returns (uint256 seizedAssets, uint256 repaidAssets);
}