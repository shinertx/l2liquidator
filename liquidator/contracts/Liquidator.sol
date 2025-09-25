// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "./interfaces/IERC20.sol";
import {IAaveV3Pool} from "./interfaces/IAaveV3Pool.sol";
import {IFlashLoanSimpleReceiver} from "./interfaces/IFlashLoanSimpleReceiver.sol";
import {ISwapRouterV3} from "./interfaces/ISwapRouterV3.sol";
import {IUniswapV2Router02} from "./interfaces/IUniswapV2Router.sol";
import {ISolidlyRouterV2} from "./interfaces/ISolidlyRouterV2.sol";
import {DexRouter} from "./libs/DexRouter.sol";
import {IPoolAddressesProvider} from "./interfaces/IPoolAddressesProvider.sol";

/// @title L2 Micro-Liquidator (Aave v3 + UniV3)
/// @notice Minimal flash-loan liquidator with on-chain minProfit & slippage guards
contract Liquidator is IFlashLoanSimpleReceiver {
    address public owner;
    bool public paused;

    IPoolAddressesProvider public immutable PROVIDER;
    ISwapRouterV3 public immutable ROUTER;
    address public beneficiary; // profits forwarded here

    mapping(address => bool) public allowedRouters;

    struct Plan {
        address borrower;
        address debtAsset;
        address collateralAsset;
        uint256 repayAmount;       // amount of debt to repay with flash
        uint8 dexId;               // 0=UniV3, 1=SolidlyV2, 2=UniV2
        address router;            // swap router to use
        uint24 uniFee;             // UniV3 pool fee
        bool solidlyStable;        // Solidly route flag
        address solidlyFactory;    // Solidly factory for the pair
        uint256 minProfit;         // in debtAsset units
        uint256 amountOutMin;      // slippage guard for collateral->debt swap
        uint256 deadline;          // swap deadline
    }

    Plan private current;

    modifier onlyOwner() { require(msg.sender == owner, "!owner"); _; }

    event Fired(address indexed borrower, address debtAsset, address collateralAsset, uint256 repayAmount);
    event Profit(address indexed asset, uint256 netProfit);
    event Paused(bool status);
    event BeneficiaryChanged(address who);
    event RouterAllowed(address router, bool allowed);

    constructor(address aaveProvider, address uniRouter, address _beneficiary) {
        owner = msg.sender;
        PROVIDER = IPoolAddressesProvider(aaveProvider);
        ROUTER = ISwapRouterV3(uniRouter);
        beneficiary = _beneficiary;
        allowedRouters[uniRouter] = true;
    }

    function setPaused(bool p) external onlyOwner { paused = p; emit Paused(p); }
    function setBeneficiary(address b) external onlyOwner { beneficiary = b; emit BeneficiaryChanged(b); }
    function setRouterAllowed(address r, bool a) external onlyOwner {
        allowedRouters[r] = a;
        emit RouterAllowed(r, a);
    }

    /// @notice Offchain bot calls this to initiate a liquidation via Aave flash loan
    function liquidateWithFlash(Plan calldata p) external onlyOwner {
        require(!paused, "paused");
        require(p.repayAmount > 0 && p.minProfit > 0, "bad plan");
        require(allowedRouters[p.router], "router !allowed");
        current = p; // store for callback
        emit Fired(p.borrower, p.debtAsset, p.collateralAsset, p.repayAmount);
        _pool().flashLoanSimple(address(this), p.debtAsset, p.repayAmount, abi.encode(p), 0);
    }

    /// @dev Aave flash loan callback
    function executeOperation(
        address asset,
        uint256 amount,
        uint256 premium,
        address /*initiator*/,
        bytes calldata params
    ) external override returns (bool) {
        IAaveV3Pool pool = _pool();
        require(msg.sender == address(pool), "only pool");
        Plan memory p = abi.decode(params, (Plan));
        // Safety: ensure callback matches requested asset/amount
        require(asset == p.debtAsset && amount == p.repayAmount, "mismatch");

        // Approve debt to pool for liquidation call
        _approveMax(p.debtAsset, address(pool), amount);
        // Perform liquidation (receive collateral)
        pool.liquidationCall(p.collateralAsset, p.debtAsset, p.borrower, amount, false);

        // Swap seized collateral -> debt asset to repay loan + premium
        uint256 collBal = IERC20(p.collateralAsset).balanceOf(address(this));
        require(collBal > 0, "no collateral");
        uint256 out;
        if (p.dexId == uint8(DexRouter.Dex.UniV3)) {
            out = DexRouter.swapUniV3(
                ISwapRouterV3(p.router),
                p.collateralAsset,
                p.debtAsset,
                p.uniFee,
                collBal,
                p.amountOutMin,
                p.deadline
            );
        } else if (p.dexId == uint8(DexRouter.Dex.SolidlyV2)) {
            out = DexRouter.swapSolidlyV2(
                ISolidlyRouterV2(p.router),
                p.collateralAsset,
                p.debtAsset,
                p.solidlyStable,
                p.solidlyFactory,
                collBal,
                p.amountOutMin,
                p.deadline
            );
        } else if (p.dexId == uint8(DexRouter.Dex.UniV2)) {
            out = DexRouter.swapUniV2(
                IUniswapV2Router02(p.router),
                p.collateralAsset,
                p.debtAsset,
                collBal,
                p.amountOutMin,
                p.deadline
            );
        } else {
            revert("dexId");
        }

        // Repay flash + premium
        uint256 owe = amount + premium;
        require(out >= owe, "insufficient out");
        _approveMax(p.debtAsset, address(pool), owe);

        // Profit check
        uint256 profit = out - owe;
        require(profit >= p.minProfit, "minProfit not met");

        // Transfer profit to beneficiary
        IERC20(p.debtAsset).transfer(beneficiary, profit);
        emit Profit(p.debtAsset, profit);
        return true;
    }

    function _approveMax(address token, address spender, uint256 needed) internal {
        if (IERC20(token).allowance(address(this), spender) < needed) {
            IERC20(token).approve(spender, type(uint256).max);
        }
    }

    function _pool() internal view returns (IAaveV3Pool) {
        return IAaveV3Pool(PROVIDER.getPool());
    }
}
