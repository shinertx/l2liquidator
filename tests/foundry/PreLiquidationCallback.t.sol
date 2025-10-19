// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import {PreLiquidationCallback} from "../../contracts/PreLiquidationCallback.sol";
import {IWETH} from "../../contracts/interfaces/IWETH.sol";
import {IERC20} from "../../contracts/interfaces/IERC20.sol";
import {SafeERC20} from "../../contracts/libs/SafeERC20.sol";
import {MockERC20} from "lib/forge-std/src/mocks/MockERC20.sol";

contract MintableToken is MockERC20 {
    constructor(string memory name_, string memory symbol_, uint8 decimals_) {
        initialize(name_, symbol_, decimals_);
    }

    function mint(address to, uint256 amount) public {
        _mint(to, amount);
    }

    function burn(address from, uint256 amount) public {
        _burn(from, amount);
    }
}

contract MockWETH is MintableToken, IWETH {
    constructor() MintableToken("Wrapped Ether", "WETH", 18) {}

    function deposit() external payable override {
        mint(msg.sender, msg.value);
    }

    function withdraw(uint256 amount) public override {
        burn(msg.sender, amount);
        (bool ok, ) = msg.sender.call{value: amount}("");
        require(ok, "NATIVE_SEND_FAIL");
    }
}

contract MockAggregator {
    using SafeERC20 for IERC20;

    IERC20 public immutable sellToken;
    IERC20 public immutable repayToken;
    IERC20 public immutable profitToken;

    constructor(IERC20 sell, IERC20 repay, IERC20 profit) {
        sellToken = sell;
        repayToken = repay;
        profitToken = profit;
    }

    function swap(uint256 amountIn, uint256 repayAmount, uint256 profitAmount) external returns (bytes memory) {
        sellToken.safeTransferFrom(msg.sender, address(this), amountIn);
        if (repayAmount > 0) {
            repayToken.safeTransfer(msg.sender, repayAmount);
        }
        if (profitAmount > 0 && address(profitToken) != address(0)) {
            profitToken.safeTransfer(msg.sender, profitAmount);
        }
        return abi.encode(amountIn, repayAmount, profitAmount);
    }
}

contract PreLiquidationCallbackTest is Test {
    MintableToken private collateral;
    MintableToken private repay;
    MintableToken private profit;
    MockWETH private weth;
    MockAggregator private aggregator;
    PreLiquidationCallback private callback;
    address payable private beneficiary = payable(address(0xBEEF));

    function setUp() public {
        collateral = new MintableToken("Collateral", "COL", 18);
        repay = new MintableToken("Repay", "REP", 6);
        profit = new MintableToken("Profit", "PRO", 18);
        weth = new MockWETH();
        aggregator = new MockAggregator(IERC20(address(collateral)), IERC20(address(repay)), IERC20(address(profit)));
        callback = new PreLiquidationCallback(address(this));

        repay.mint(address(aggregator), 1_000_000e6);
        profit.mint(address(aggregator), 1_000 ether);
    }

    function testOnPreLiquidateForwardsRepayAndProfit() public {
        uint256 repayAssets = 90_000e6;
        uint256 swapRepay = 100_000e6;
        uint256 profitAmount = 5 ether;
        uint256 collateralSeized = 10_000 ether;

        collateral.mint(address(callback), collateralSeized);

        PreLiquidationCallback.CallbackPayload memory payload = PreLiquidationCallback.CallbackPayload({
            repayToken: address(repay),
            minRepayAssets: 80_000e6,
            swapTarget: address(aggregator),
            swapData: abi.encodeWithSelector(MockAggregator.swap.selector, collateralSeized, swapRepay, profitAmount),
            profitToken: address(profit),
            beneficiary: beneficiary,
            sellToken: address(collateral),
            sellAmount: collateralSeized,
            wrappedNative: address(weth)
        });

        uint256 beneficiaryRepayBefore = repay.balanceOf(beneficiary);
        uint256 beneficiaryProfitBefore = profit.balanceOf(beneficiary);

    callback.onPreLiquidate(repayAssets, abi.encode(payload));

        assertEq(repay.balanceOf(address(this)), repayAssets, "preliq contract received repay amount");
        assertEq(repay.balanceOf(beneficiary) - beneficiaryRepayBefore, swapRepay - repayAssets, "leftover repay swept");
        assertEq(profit.balanceOf(beneficiary) - beneficiaryProfitBefore, profitAmount, "profit token forwarded");
        assertEq(collateral.balanceOf(address(callback)), 0, "no collateral remains");
    }

    function testOnPreLiquidateUnwrapsWethAndSendsNative() public {
        aggregator = new MockAggregator(IERC20(address(collateral)), IERC20(address(repay)), IERC20(address(weth)));
        callback = new PreLiquidationCallback(address(this));

        uint256 repayAssets = 50_000e6;
        uint256 swapRepay = 60_000e6;
        uint256 collateralSeized = 5_000 ether;
        uint256 wethProfit = 1 ether;

        repay.mint(address(aggregator), 500_000e6);
        collateral.mint(address(callback), collateralSeized);

        // Provide WETH liquidity to aggregator backed by native ETH.
        vm.deal(address(this), wethProfit);
        weth.deposit{value: wethProfit}();
        weth.transfer(address(aggregator), wethProfit);

        PreLiquidationCallback.CallbackPayload memory payload = PreLiquidationCallback.CallbackPayload({
            repayToken: address(repay),
            minRepayAssets: 45_000e6,
            swapTarget: address(aggregator),
            swapData: abi.encodeWithSelector(MockAggregator.swap.selector, collateralSeized, swapRepay, wethProfit),
            profitToken: address(weth),
            beneficiary: beneficiary,
            sellToken: address(collateral),
            sellAmount: collateralSeized,
            wrappedNative: address(weth)
        });

        uint256 beneficiaryNativeBefore = beneficiary.balance;

        callback.onPreLiquidate(repayAssets, abi.encode(payload));

        assertEq(repay.balanceOf(address(this)), repayAssets, "repay forwarded to preliq contract");
        assertEq(beneficiary.balance - beneficiaryNativeBefore, wethProfit, "beneficiary received native profit");
        assertEq(IERC20(address(weth)).balanceOf(address(callback)), 0, "no WETH residue");
    }
}
