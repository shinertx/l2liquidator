// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./interfaces/IPoolAddressesProvider.sol";
import "./interfaces/IPool.sol";
import "./interfaces/IFlashLoanSimpleReceiver.sol";
import "./interfaces/IERC20.sol";
import "./libs/SafeERC20.sol";

/**
 * @title SeamlessLiquidator
 * @notice Flash loan liquidator for Seamless Protocol (Aave v3 fork) on Base
 * @dev Seamless uses identical interfaces to Aave v3, so we can reuse most logic
 */
contract SeamlessLiquidator is IFlashLoanSimpleReceiver {
    using SafeERC20 for IERC20;

    // ============================================
    // CONSTANTS & IMMUTABLES
    // ============================================

    address public immutable owner;
    address public immutable beneficiary;
    IPoolAddressesProvider public immutable ADDRESSES_PROVIDER;
    IPool public immutable POOL;

    // ============================================
    // ERRORS
    // ============================================

    error Unauthorized();
    error InvalidFlashLoanCaller();
    error InvalidFlashLoanInitiator();
    error InsufficientProfit();
    error SwapFailed();

    // ============================================
    // EVENTS
    // ============================================

    event LiquidationExecuted(
        address indexed collateralAsset,
        address indexed debtAsset,
        address indexed borrower,
        uint256 debtToCover,
        uint256 collateralSeized,
        uint256 profitUsd
    );

    event ProfitExtracted(address indexed token, uint256 amount);

    // ============================================
    // STRUCTS
    // ============================================

    struct LiquidationParams {
        address collateralAsset;
        address debtAsset;
        address borrower;
        uint256 debtToCover;
        uint256 minProfitBps; // Minimum profit in basis points (10000 = 100%)
    }

    struct SwapParams {
        address router; // Uniswap V3 router
        bytes path; // Encoded swap path
        uint256 minAmountOut; // Slippage protection
    }

    // ============================================
    // CONSTRUCTOR
    // ============================================

    constructor(address _addressProvider, address _beneficiary) {
        owner = msg.sender;
        beneficiary = _beneficiary;
        ADDRESSES_PROVIDER = IPoolAddressesProvider(_addressProvider);
        POOL = IPool(IPoolAddressesProvider(_addressProvider).getPool());
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
     * @notice Execute flash loan liquidation on Seamless
     * @param liquidationParams Liquidation parameters
     * @param swapParams Swap parameters for collateral->debt swap
     */
    function liquidate(
        LiquidationParams calldata liquidationParams,
        SwapParams calldata swapParams
    ) external onlyOwner {
        // Validate parameters
        require(liquidationParams.debtToCover > 0, "Invalid debt amount");
        require(liquidationParams.borrower != address(0), "Invalid borrower");

        // Encode params for flash loan callback
        bytes memory params = abi.encode(liquidationParams, swapParams);

        // Execute flash loan
        POOL.flashLoanSimple(
            address(this),
            liquidationParams.debtAsset,
            liquidationParams.debtToCover,
            params,
            0 // referralCode
        );
    }

    // ============================================
    // FLASH LOAN CALLBACK
    // ============================================

    /**
     * @notice Flash loan callback - executes liquidation and swap
     * @param asset The flash loaned asset (debt token)
     * @param amount The flash loan amount
     * @param premium The flash loan fee
     * @param initiator The flash loan initiator (must be this contract)
     * @param params Encoded liquidation and swap parameters
     */
    function executeOperation(
        address asset,
        uint256 amount,
        uint256 premium,
        address initiator,
        bytes calldata params
    ) external override returns (bool) {
        // Security checks
        if (msg.sender != address(POOL)) revert InvalidFlashLoanCaller();
        if (initiator != address(this)) revert InvalidFlashLoanInitiator();

        // Decode parameters
        (LiquidationParams memory liqParams, SwapParams memory swapParams) = abi.decode(
            params,
            (LiquidationParams, SwapParams)
        );

        // 1. Approve debt token for liquidation
        IERC20(asset).safeIncreaseAllowance(address(POOL), amount);

        // 2. Execute liquidation on Seamless
        POOL.liquidationCall(
            liqParams.collateralAsset,
            liqParams.debtAsset,
            liqParams.borrower,
            liqParams.debtToCover,
            false // don't receive aToken
        );

        // 3. Swap collateral back to debt token
        uint256 collateralBalance = IERC20(liqParams.collateralAsset).balanceOf(address(this));
        require(collateralBalance > 0, "No collateral received");

        uint256 debtReceived = _swap(
            liqParams.collateralAsset,
            liqParams.debtAsset,
            collateralBalance,
            swapParams
        );

        // 4. Calculate profit
        uint256 amountOwed = amount + premium;
        require(debtReceived >= amountOwed, "Insufficient swap output");
        
        uint256 profit = debtReceived - amountOwed;
        
        // 5. Enforce minimum profit threshold
        uint256 minProfit = (amount * liqParams.minProfitBps) / 10000;
        if (profit < minProfit) revert InsufficientProfit();

        // 6. Approve repayment
        IERC20(asset).safeIncreaseAllowance(address(POOL), amountOwed);

        // 7. Emit event
        emit LiquidationExecuted(
            liqParams.collateralAsset,
            liqParams.debtAsset,
            liqParams.borrower,
            liqParams.debtToCover,
            collateralBalance,
            profit
        );

        return true;
    }

    // ============================================
    // SWAP LOGIC
    // ============================================

    /**
     * @notice Swap collateral to debt token via Uniswap V3
     * @param tokenIn Collateral token
     * @param tokenOut Debt token
     * @param amountIn Collateral amount to swap
     * @param swapParams Swap configuration
     * @return amountOut Amount of debt token received
     */
    function _swap(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        SwapParams memory swapParams
    ) internal returns (uint256 amountOut) {
        // Approve router
        IERC20(tokenIn).safeIncreaseAllowance(swapParams.router, amountIn);

        // Execute swap via low-level call
        // Using exactInput for Uniswap V3
        bytes memory swapCall = abi.encodeWithSignature(
            "exactInput((bytes,address,uint256,uint256,uint256))",
            swapParams.path,
            address(this),
            block.timestamp,
            amountIn,
            swapParams.minAmountOut
        );

        (bool success, bytes memory returnData) = swapParams.router.call(swapCall);
        if (!success) revert SwapFailed();

        amountOut = abi.decode(returnData, (uint256));
        require(amountOut >= swapParams.minAmountOut, "Slippage exceeded");
    }

    // ============================================
    // PROFIT EXTRACTION
    // ============================================

    /**
     * @notice Extract profits to beneficiary
     * @param token Token to extract
     */
    function extractProfit(address token) external onlyOwner {
        uint256 balance = IERC20(token).balanceOf(address(this));
        if (balance > 0) {
            IERC20(token).safeTransfer(beneficiary, balance);
            emit ProfitExtracted(token, balance);
        }
    }

    /**
     * @notice Extract ETH profits to beneficiary
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

    function ADDRESSES_PROVIDER_ADDR() external view returns (address) {
        return address(ADDRESSES_PROVIDER);
    }

    function POOL_ADDR() external view returns (address) {
        return address(POOL);
    }

    // Fallback to receive ETH
    receive() external payable {}
}
