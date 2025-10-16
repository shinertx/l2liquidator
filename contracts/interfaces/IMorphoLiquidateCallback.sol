// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IMorphoLiquidateCallback {
    function onMorphoLiquidate(uint256 repaidAssets, bytes calldata data) external;
}
