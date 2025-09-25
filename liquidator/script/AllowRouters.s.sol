// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import {Liquidator} from "../contracts/Liquidator.sol";

contract AllowRouters is Script {
    function run() external {
        address liq = vm.envAddress("LIQUIDATOR");
        address[] memory routers = new address[](5);
        uint256 n;
        // Required
        address uni = vm.envOr("UNIV3_ROUTER", address(0));
        if (uni != address(0)) { routers[n++] = uni; }
        // Optional secondaries
        address v = vm.envOr("SECONDARY_ROUTER1", address(0));
        if (v != address(0)) { routers[n++] = v; }
        address v2 = vm.envOr("SECONDARY_ROUTER2", address(0));
        if (v2 != address(0)) { routers[n++] = v2; }
        address v3 = vm.envOr("SECONDARY_ROUTER3", address(0));
        if (v3 != address(0)) { routers[n++] = v3; }
        address v4 = vm.envOr("SECONDARY_ROUTER4", address(0));
        if (v4 != address(0)) { routers[n++] = v4; }

        vm.startBroadcast();
        for (uint256 i = 0; i < n; i++) {
            Liquidator(liq).setRouterAllowed(routers[i], true);
        }
        vm.stopBroadcast();
    }
}
