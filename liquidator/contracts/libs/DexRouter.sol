// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ISwapRouterV3} from "../interfaces/ISwapRouterV3.sol";
import {IUniswapV2Router02} from "../interfaces/IUniswapV2Router.sol";
import {ISolidlyRouterV2} from "../interfaces/ISolidlyRouterV2.sol";
import {IERC20} from "../interfaces/IERC20.sol";

library DexRouter {
    enum Dex {
        UniV3,
        SolidlyV2,
        UniV2
    }

    function _approve(address token, address spender, uint256 amount) private {
        if (IERC20(token).allowance(address(this), spender) < amount) {
            IERC20(token).approve(spender, type(uint256).max);
        }
    }

    function swapUniV3(
        ISwapRouterV3 router,
        address tokenIn,
        address tokenOut,
        uint24 fee,
        uint256 amountIn,
        uint256 amountOutMin,
        uint256 deadline
    ) internal returns (uint256 out) {
        _approve(tokenIn, address(router), amountIn);
        out = router.exactInputSingle(
            ISwapRouterV3.ExactInputSingleParams({
                tokenIn: tokenIn,
                tokenOut: tokenOut,
                fee: fee,
                recipient: address(this),
                deadline: deadline,
                amountIn: amountIn,
                amountOutMinimum: amountOutMin,
                sqrtPriceLimitX96: 0
            })
        );
    }

    function swapSolidlyV2(
        ISolidlyRouterV2 router,
        address tokenIn,
        address tokenOut,
        bool stable,
        address factory,
        uint256 amountIn,
        uint256 amountOutMin,
        uint256 deadline
    ) internal returns (uint256 out) {
        _approve(tokenIn, address(router), amountIn);
        ISolidlyRouterV2.Route[] memory routes = new ISolidlyRouterV2.Route[](1);
        routes[0] = ISolidlyRouterV2.Route({from: tokenIn, to: tokenOut, stable: stable, factory: factory});
        uint256[] memory amounts = router.swapExactTokensForTokens(amountIn, amountOutMin, routes, address(this), deadline);
        out = amounts[amounts.length - 1];
    }

    function swapUniV2(
        IUniswapV2Router02 router,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOutMin,
        uint256 deadline
    ) internal returns (uint256 out) {
        _approve(tokenIn, address(router), amountIn);
        address[] memory path = new address[](2);
        path[0] = tokenIn;
        path[1] = tokenOut;
        uint256[] memory amounts = router.swapExactTokensForTokens(amountIn, amountOutMin, path, address(this), deadline);
        out = amounts[amounts.length - 1];
    }
}
