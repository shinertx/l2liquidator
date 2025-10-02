// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import {Liquidator} from "../../contracts/Liquidator.sol";

contract LiquidatorForkTest is Test {
    Liquidator internal liquidator;
    bool internal forkActive;

    function setUp() public {
        string memory forkUrl = vm.envOr("ARB_FORK_RPC_URL", string(""));
        if (bytes(forkUrl).length == 0) {
            forkUrl = vm.envOr("FORK_RPC_URL", string(""));
        }

        if (bytes(forkUrl).length == 0) {
            forkActive = false;
            return;
        }

        forkActive = true;
        vm.createSelectFork(forkUrl);

    address pool = vm.envOr("ARB_AAVE_POOL", address(0x794a61358D6845594F94Dc1db02A252B5B481d05));
        address router = vm.envOr("ARB_UNIV3_ROUTER", address(0xE592427A0AEce92De3Edee1F18E0157C05861564));
        address beneficiary = address(0xBEEF);
        liquidator = new Liquidator(pool, router, beneficiary);
    }

    function testBeneficiarySetOnFork() public view {
        if (!forkActive) return;
        assertEq(liquidator.beneficiary(), address(0xBEEF));
    }

    function testPauseAndResumeOnFork() public {
        if (!forkActive) return;
        liquidator.setPaused(true);
        assertTrue(liquidator.paused());
        liquidator.setPaused(false);
        assertFalse(liquidator.paused());
    }
}
