// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {DripFactory} from "../src/DripFactory.sol";

/// @dev Deploy the multi-tenant drip factory (10% platform fee by default).
contract DeployDripFactory is Script {
    address internal constant DEFAULT_OWNER = 0x374D91a5674Fa7Cf86E725093b5848b97e1e13b4;
    address internal constant DEFAULT_KEEPER = 0x6eb052b25399809F858Dc1B69b8Ff9225aE44b54;
    address internal constant DEFAULT_TREASURY = 0x374D91a5674Fa7Cf86E725093b5848b97e1e13b4;
    address internal constant DEFAULT_LOCK_VAULT = 0xeFC8591519a2D8885C1b62C7de84ce906F22Fa78;
    uint256 internal constant DEFAULT_LOCK_SECONDS = 2_175_984_000;
    uint16 internal constant DEFAULT_FEE_BPS = 1000; // 10%

    function run() external {
        address owner = vm.envOr("PAYOUT_OWNER", DEFAULT_OWNER);
        address keeper = vm.envOr("PAYOUT_KEEPER", DEFAULT_KEEPER);
        address treasury = vm.envOr("TREASURY", DEFAULT_TREASURY);
        address lockVault = vm.envOr("LOCK_VAULT", DEFAULT_LOCK_VAULT);
        uint256 lockSeconds = vm.envOr("LOCK_SECONDS", DEFAULT_LOCK_SECONDS);
        uint16 feeBps = uint16(vm.envOr("PLATFORM_FEE_BPS", uint256(DEFAULT_FEE_BPS)));

        vm.startBroadcast();
        DripFactory factory = new DripFactory(owner, keeper, treasury, lockVault, lockSeconds, feeBps);
        vm.stopBroadcast();

        console.log("DRIP_FACTORY", address(factory));
        console.log("OWNER", owner);
        console.log("KEEPER", keeper);
        console.log("TREASURY", treasury);
        console.log("PLATFORM_FEE_BPS", feeBps);
    }
}
