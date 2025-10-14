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
import {IMorpho, MarketParams} from "./interfaces/IMorpho.sol";

/// @title Morpho Blue Liquidator
/// @notice Flash-loan liquidator targeting Morpho Blue positions with on-chain profit & slippage guards
contract MorphoBlueLiquidator is IFlashLoanSimpleReceiver {
    address public owner;
    address public pendingOwner;
    bool public paused;

    IPoolAddressesProvider public immutable PROVIDER;
    ISwapRouterV3 public immutable ROUTER;
    IMorpho public immutable MORPHO;
    address public beneficiary;

    mapping(address => bool) public allowedRouters;
    mapping(address => bool) public executors;

    struct Plan {
        MarketParams market;
        address borrower;
        uint256 repayAmount;
        uint256 repayShares;
        uint8 dexId;
        address router;
        uint24 uniFee;
        bool solidlyStable;
        address solidlyFactory;
        uint256 minProfit;
        uint256 amountOutMin;
        uint256 deadline;
        bytes path;
        bytes callbackData;
    }

    modifier onlyOwner() {
        require(msg.sender == owner, "!owner");
        _;
    }

    modifier onlyOwnerOrExecutor() {
        require(msg.sender == owner || executors[msg.sender], "!executor");
        _;
    }

    event Fired(address indexed borrower, address debtAsset, address collateralAsset, uint256 repayAmount, uint256 repayShares);
    event Profit(address indexed asset, uint256 netProfit);
    event Paused(bool status);
    event BeneficiaryChanged(address who);
    event RouterAllowed(address router, bool allowed);
    event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event ExecutorUpdated(address indexed executor, bool allowed);

    constructor(address aaveProvider, address uniRouter, address morpho, address _beneficiary) {
        require(morpho != address(0), "morpho=0");
        owner = msg.sender;
        PROVIDER = IPoolAddressesProvider(aaveProvider);
        ROUTER = ISwapRouterV3(uniRouter);
        MORPHO = IMorpho(morpho);
        beneficiary = _beneficiary;
        allowedRouters[uniRouter] = true;
        executors[msg.sender] = true;
    }

    function setPaused(bool p) external onlyOwner {
        paused = p;
        emit Paused(p);
    }

    function setBeneficiary(address b) external onlyOwner {
        beneficiary = b;
        emit BeneficiaryChanged(b);
    }

    function setRouterAllowed(address r, bool a) external onlyOwner {
        allowedRouters[r] = a;
        emit RouterAllowed(r, a);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "zero addr");
        pendingOwner = newOwner;
        emit OwnershipTransferStarted(owner, newOwner);
    }

    function acceptOwnership() external {
        require(msg.sender == pendingOwner, "!pending");
        address previous = owner;
        owner = pendingOwner;
        pendingOwner = address(0);
        executors[owner] = true;
        emit OwnershipTransferred(previous, owner);
    }

    function setExecutor(address exec, bool allowed) external onlyOwner {
        executors[exec] = allowed;
        emit ExecutorUpdated(exec, allowed);
    }

    function liquidateWithFlash(Plan calldata p) external onlyOwnerOrExecutor {
        require(!paused, "paused");
        require(p.repayAmount > 0 && p.repayShares > 0 && p.minProfit > 0, "bad plan");
        require(allowedRouters[p.router], "router !allowed");
        require(p.market.loanToken != address(0) && p.market.collateralToken != address(0), "market assets");
        emit Fired(p.borrower, p.market.loanToken, p.market.collateralToken, p.repayAmount, p.repayShares);
        _pool().flashLoanSimple(address(this), p.market.loanToken, p.repayAmount, abi.encode(p), 0);
    }

    function liquidateWithFunds(Plan calldata p) external onlyOwner {
        require(!paused, "paused");
        require(p.repayAmount > 0 && p.repayShares > 0 && p.minProfit > 0, "bad plan");
        require(allowedRouters[p.router], "router !allowed");
        IERC20 debt = IERC20(p.market.loanToken);
        require(debt.balanceOf(address(this)) >= p.repayAmount, "funds low");
        _approveMax(p.market.loanToken, address(MORPHO), p.repayAmount);
        (uint256 seizedAssets, uint256 repaidAssets) = MORPHO.liquidate(
            p.market,
            p.borrower,
            0,
            p.repayShares,
            p.callbackData
        );
        require(seizedAssets > 0 && repaidAssets > 0, "morpho zero");
        uint256 profit = _finalizeFunds(p, repaidAssets);
        emit Profit(p.market.loanToken, profit);
    }

    function executeOperation(
        address asset,
        uint256 amount,
        uint256 premium,
        address,
        bytes calldata params
    ) external override returns (bool) {
        IAaveV3Pool pool = _pool();
        require(msg.sender == address(pool), "only pool");
        Plan memory p = abi.decode(params, (Plan));
        require(asset == p.market.loanToken, "asset mismatch");
        require(amount == p.repayAmount, "amount mismatch");

        _approveMax(p.market.loanToken, address(MORPHO), amount);
        (uint256 seizedAssets, uint256 repaidAssets) = MORPHO.liquidate(
            p.market,
            p.borrower,
            0,
            p.repayShares,
            p.callbackData
        );
        require(seizedAssets > 0 && repaidAssets > 0, "morpho zero");
        require(repaidAssets <= amount, "repay gt flash");

        uint256 profit = _finalizeFlash(p, pool, amount, premium, repaidAssets);
        emit Profit(p.market.loanToken, profit);
        return true;
    }

    function _finalizeFlash(
        Plan memory p,
        IAaveV3Pool pool,
        uint256 amount,
        uint256 premium,
        uint256 /*repaidAssets*/
    ) internal returns (uint256) {
        address debtAsset = p.market.loanToken;
    _swapCollateralForDebt(p);
    uint256 debtAfter = IERC20(debtAsset).balanceOf(address(this));
        uint256 totalDebt = debtAfter;
        uint256 owe = amount + premium;
        require(totalDebt >= owe, "insufficient out");

        _approveMax(debtAsset, address(pool), owe);

        uint256 profit = totalDebt - owe;
        require(profit >= p.minProfit, "minProfit not met");

        if (profit > 0) {
            bool ok = IERC20(debtAsset).transfer(beneficiary, profit);
            require(ok, "profit transfer failed");
        }
        return profit;
    }

    function _finalizeFunds(Plan memory p, uint256 spent) internal returns (uint256) {
        address debtAsset = p.market.loanToken;
        uint256 swapOut = _swapCollateralForDebt(p);
        require(swapOut >= spent, "insufficient out");

        uint256 profit = swapOut - spent;
        require(profit >= p.minProfit, "minProfit not met");

        if (profit > 0) {
            bool ok = IERC20(debtAsset).transfer(beneficiary, profit);
            require(ok, "profit transfer failed");
        }
        return profit;
    }

    function _swapCollateralForDebt(Plan memory p) internal returns (uint256 out) {
        address collateralAsset = p.market.collateralToken;
        uint256 collBal = IERC20(collateralAsset).balanceOf(address(this));
        require(collBal > 0, "no collateral");
        if (p.dexId == uint8(DexRouter.Dex.UniV3)) {
            out = DexRouter.swapUniV3(
                ISwapRouterV3(p.router),
                collateralAsset,
                p.market.loanToken,
                p.uniFee,
                collBal,
                p.amountOutMin,
                p.deadline
            );
        } else if (p.dexId == uint8(DexRouter.Dex.SolidlyV2)) {
            out = DexRouter.swapSolidlyV2(
                ISolidlyRouterV2(p.router),
                collateralAsset,
                p.market.loanToken,
                p.solidlyStable,
                p.solidlyFactory,
                collBal,
                p.amountOutMin,
                p.deadline
            );
        } else if (p.dexId == uint8(DexRouter.Dex.UniV2)) {
            out = DexRouter.swapUniV2(
                IUniswapV2Router02(p.router),
                collateralAsset,
                p.market.loanToken,
                collBal,
                p.amountOutMin,
                p.deadline
            );
        } else if (p.dexId == uint8(DexRouter.Dex.UniV3Multi)) {
            out = DexRouter.swapUniV3Multi(
                ISwapRouterV3(p.router),
                p.path,
                collBal,
                p.amountOutMin,
                p.deadline
            );
        } else {
            revert("dexId");
        }
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
