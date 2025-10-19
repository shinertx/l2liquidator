// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "./interfaces/IERC20.sol";
import {IWETH} from "./interfaces/IWETH.sol";
import {SafeERC20} from "./libs/SafeERC20.sol";

/// @title PreLiquidationCallback
/// @notice Executes aggregator swaps during Morpho Blue pre-liquidations and forwards proceeds.
contract PreLiquidationCallback {
    using SafeERC20 for IERC20;

    struct CallbackPayload {
        address repayToken;
        uint256 minRepayAssets;
        address swapTarget;
        bytes swapData;
        address profitToken;
        address beneficiary;
        address sellToken;
        uint256 sellAmount;
        address wrappedNative;
    }

    error UnauthorizedCaller(address caller);
    error InvalidPayload();
    error SwapFailed();
    error InsufficientRepay(uint256 balance, uint256 required);
    error NativeTransferFailed();

    address public immutable preLiquidation;

    constructor(address _preLiquidation) {
        if (_preLiquidation == address(0)) revert InvalidPayload();
        preLiquidation = _preLiquidation;
    }

    receive() external payable {}

    /// @notice Morpho pre-liquidation callback entrypoint.
    /// @param repayAssets Amount of debt assets expected by Morpho's pre-liquidation contract.
    /// @param data ABI-encoded CallbackPayload containing routing metadata.
    /// @return swapResult Raw response from the aggregator call (if any).
    function onPreLiquidate(uint256 repayAssets, bytes calldata data) external returns (bytes memory swapResult) {
        if (msg.sender != preLiquidation) revert UnauthorizedCaller(msg.sender);
        CallbackPayload memory payload = abi.decode(data, (CallbackPayload));
        if (payload.beneficiary == address(0)) revert InvalidPayload();
        if (repayAssets == 0 || payload.sellAmount == 0) revert InvalidPayload();

        _approve(payload.swapTarget, payload.sellToken, payload.sellAmount);

        bool ok;
        (ok, swapResult) = payload.swapTarget.call(payload.swapData);
        if (!ok) revert SwapFailed();

        _approve(payload.swapTarget, payload.sellToken, 0);

        uint256 repayBalance = IERC20(payload.repayToken).balanceOf(address(this));
        if (repayBalance < repayAssets || repayBalance < payload.minRepayAssets) {
            revert InsufficientRepay(repayBalance, repayAssets > payload.minRepayAssets ? repayAssets : payload.minRepayAssets);
        }

        IERC20(payload.repayToken).safeTransfer(msg.sender, repayAssets);

        _sweepToken(payload.repayToken, payload.beneficiary, payload.wrappedNative);
        if (payload.profitToken != payload.repayToken) {
            _sweepToken(payload.profitToken, payload.beneficiary, payload.wrappedNative);
        }
        if (payload.sellToken != payload.repayToken && payload.sellToken != payload.profitToken) {
            _sweepToken(payload.sellToken, payload.beneficiary, payload.wrappedNative);
        }
        _sweepNative(payload.beneficiary);
    }

    function _approve(address spender, address token, uint256 amount) private {
        if (token == address(0)) return;
        IERC20(token).safeApprove(spender, 0);
        if (amount > 0) {
            IERC20(token).safeApprove(spender, amount);
        }
    }

    function _sweepToken(address token, address beneficiary, address wrappedNative) private {
        if (token == address(0)) return;
        uint256 bal = IERC20(token).balanceOf(address(this));
        if (bal == 0) return;
        if (token == wrappedNative) {
            IWETH(token).withdraw(bal);
            _sweepNative(beneficiary);
            return;
        }
        IERC20(token).safeTransfer(beneficiary, bal);
    }

    function _sweepNative(address beneficiary) private {
        uint256 bal = address(this).balance;
        if (bal == 0) return;
        (bool sent, ) = beneficiary.call{value: bal}(new bytes(0));
        if (!sent) revert NativeTransferFailed();
    }
}
