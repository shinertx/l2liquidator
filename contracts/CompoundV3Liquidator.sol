// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title CompoundV3Liquidator
 * @notice Flash loan liquidator for Compound V3 (Comet) on Arbitrum and Base
 * @dev Uses absorb() + buyCollateral() flow instead of traditional liquidationCall()
 */

// Compound V3 Interfaces
interface IComet {
    function absorb(address absorber, address[] calldata accounts) external;
    function buyCollateral(
        address asset,
        uint minAmount,
        uint baseAmount,
        address recipient
    ) external;
    function isLiquidatable(address account) external view returns (bool);
    function collateralBalanceOf(address account, address asset) external view returns (uint128);
    function baseToken() external view returns (address);
    function getAssetInfoByAddress(address asset) external view returns (AssetInfo memory);
    
    struct AssetInfo {
        uint8 offset;
        address asset;
        address priceFeed;
        uint64 scale;
        uint64 borrowCollateralFactor;
        uint64 liquidateCollateralFactor;
        uint64 liquidationFactor;
        uint128 supplyCap;
    }
}

interface IERC20 {
    function approve(address spender, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

interface ISwapRouter {
    struct ExactInputParams {
        bytes path;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
    }
    
    function exactInput(ExactInputParams calldata params) external payable returns (uint256 amountOut);
}

contract CompoundV3Liquidator {
    // ============================================
    // CONSTANTS & IMMUTABLES
    // ============================================

    address public immutable owner;
    address public immutable beneficiary;

    // ============================================
    // ERRORS
    // ============================================

    error Unauthorized();
    error NotLiquidatable();
    error InsufficientProfit();
    error SwapFailed();
    error AbsorbFailed();
    error BuyCollateralFailed();

    // ============================================
    // EVENTS
    // ============================================

    event LiquidationExecuted(
        address indexed comet,
        address indexed borrower,
        address indexed collateralAsset,
        uint256 collateralAmount,
        uint256 baseAmountPaid,
        uint256 profitUsd
    );

    event ProfitExtracted(address indexed token, uint256 amount);

    // ============================================
    // STRUCTS
    // ============================================

    struct LiquidationParams {
        address comet;              // Comet contract address
        address borrower;           // Account to liquidate
        address collateralAsset;    // Collateral asset to seize
        uint256 minProfit;          // Minimum profit in base asset
    }

    struct SwapParams {
        address router;             // Uniswap V3 router
        bytes pathCollateralToBase; // Collateral → base asset
        uint256 minAmountOut;       // Slippage protection
    }

    // ============================================
    // CONSTRUCTOR
    // ============================================

    constructor(address _beneficiary) {
        owner = msg.sender;
        beneficiary = _beneficiary;
    }

    // ============================================
    // MODIFIERS
    // ============================================

    modifier onlyOwner() {
        if (msg.sender != owner) revert Unauthorized();
        _;
    }

    // ============================================
    // MAIN LIQUIDATION FUNCTION
    // ============================================

    /**
     * @notice Execute Compound V3 liquidation
     * @param params Liquidation parameters
     * @param swapParams Swap parameters for collateral→base conversion
     */
    function liquidate(
        LiquidationParams calldata params,
        SwapParams calldata swapParams
    ) external onlyOwner {
        IComet comet = IComet(params.comet);
        
        // 1. Verify account is liquidatable
        if (!comet.isLiquidatable(params.borrower)) {
            revert NotLiquidatable();
        }

        // 2. Absorb the position (protocol takes full position)
        address[] memory accounts = new address[](1);
        accounts[0] = params.borrower;
        
        try comet.absorb(address(this), accounts) {
            // Absorption successful
        } catch {
            revert AbsorbFailed();
        }

        // 3. Check how much collateral the protocol absorbed
        uint256 absorbedCollateral = comet.collateralBalanceOf(address(this), params.collateralAsset);
        require(absorbedCollateral > 0, "No collateral absorbed");

        // 4. If collateral is not the base asset, swap to base first
        address baseAsset = comet.baseToken();
        uint256 baseAmountForPurchase;

        if (params.collateralAsset != baseAsset) {
            // We need base asset to buy collateral, so we need flash loan or existing balance
            // For now, assume we have base asset available
            // In production, integrate flash loan here
            baseAmountForPurchase = IERC20(baseAsset).balanceOf(address(this));
            require(baseAmountForPurchase > 0, "Need base asset for purchase");
        }

        // 5. Buy collateral from protocol at discount
        IERC20(baseAsset).approve(params.comet, type(uint256).max);
        
        uint256 baseBalanceBefore = IERC20(baseAsset).balanceOf(address(this));
        
        try comet.buyCollateral(
            params.collateralAsset,
            0, // minAmount - we'll check profit after
            baseAmountForPurchase,
            address(this)
        ) {
            // Purchase successful
        } catch {
            revert BuyCollateralFailed();
        }

        uint256 baseBalanceAfter = IERC20(baseAsset).balanceOf(address(this));
        uint256 baseSpent = baseBalanceBefore - baseBalanceAfter;

        // 6. Get collateral balance
        uint256 collateralReceived = IERC20(params.collateralAsset).balanceOf(address(this));

        // 7. Swap collateral back to base asset
        uint256 baseReceived = _swap(
            params.collateralAsset,
            baseAsset,
            collateralReceived,
            swapParams
        );

        // 8. Calculate profit
        uint256 profit = baseReceived > baseSpent ? baseReceived - baseSpent : 0;
        
        if (profit < params.minProfit) {
            revert InsufficientProfit();
        }

        // 9. Emit event
        emit LiquidationExecuted(
            params.comet,
            params.borrower,
            params.collateralAsset,
            collateralReceived,
            baseSpent,
            profit
        );
    }

    /**
     * @notice Execute liquidation with flash loan funding
     * @dev This version uses flash loan to fund the buyCollateral call
     */
    function liquidateWithFlashLoan(
        LiquidationParams calldata params,
        SwapParams calldata swapParams,
        uint256 flashLoanAmount
    ) external onlyOwner {
        // TODO: Integrate with Aave/Balancer flash loans
        // This would allow liquidations without upfront capital
        revert("Not implemented yet");
    }

    // ============================================
    // SWAP LOGIC
    // ============================================

    /**
     * @notice Swap tokens via Uniswap V3
     */
    function _swap(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        SwapParams memory swapParams
    ) internal returns (uint256 amountOut) {
        if (amountIn == 0) return 0;

        // Approve router
        IERC20(tokenIn).approve(swapParams.router, amountIn);

        // Execute swap
        ISwapRouter.ExactInputParams memory params = ISwapRouter.ExactInputParams({
            path: swapParams.pathCollateralToBase,
            recipient: address(this),
            deadline: block.timestamp,
            amountIn: amountIn,
            amountOutMinimum: swapParams.minAmountOut
        });

        try ISwapRouter(swapParams.router).exactInput(params) returns (uint256 _amountOut) {
            amountOut = _amountOut;
        } catch {
            revert SwapFailed();
        }

        require(amountOut >= swapParams.minAmountOut, "Slippage exceeded");
    }

    // ============================================
    // PROFIT EXTRACTION
    // ============================================

    /**
     * @notice Extract profits to beneficiary
     */
    function extractProfit(address token) external onlyOwner {
        uint256 balance = IERC20(token).balanceOf(address(this));
        if (balance > 0) {
            IERC20(token).transfer(beneficiary, balance);
            emit ProfitExtracted(token, balance);
        }
    }

    /**
     * @notice Extract ETH profits
     */
    function extractETH() external onlyOwner {
        uint256 balance = address(this).balance;
        if (balance > 0) {
            (bool success, ) = beneficiary.call{value: balance}("");
            require(success, "ETH transfer failed");
            emit ProfitExtracted(address(0), balance);
        }
    }

    // ============================================
    // VIEW FUNCTIONS
    // ============================================

    /**
     * @notice Check if account is liquidatable on specific Comet
     */
    function checkLiquidatable(address comet, address account) external view returns (bool) {
        return IComet(comet).isLiquidatable(account);
    }

    // Fallback to receive ETH
    receive() external payable {}
}
