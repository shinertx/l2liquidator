// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import {Liquidator} from "../contracts/Liquidator.sol";
import {MorphoBlueLiquidator} from "../contracts/MorphoBlueLiquidator.sol";

contract Deploy is Script {
    function run() external {
        address provider = vm.envAddress("AAVE_V3_PROVIDER");
        address uniRouter = vm.envAddress("UNIV3_ROUTER");
        address beneficiary = vm.envAddress("BENEFICIARY");
        vm.startBroadcast();
        Liquidator liq = new Liquidator(provider, uniRouter, beneficiary);
        vm.stopBroadcast();
        console2.log("Liquidator:", address(liq));
    }
}

contract MorphoBlueDeploy is Script {
    function run() external {
        address uniRouter = vm.envAddress("UNIV3_ROUTER");
        address morpho = vm.envAddress("MORPHO_BLUE_CORE");
        address beneficiary = vm.envAddress("BENEFICIARY");
        vm.startBroadcast();
        MorphoBlueLiquidator liq = new MorphoBlueLiquidator(uniRouter, morpho, beneficiary);
        vm.stopBroadcast();
        console2.log("MorphoBlueLiquidator:", address(liq));
    }
}