// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {DevMsftFeeRouter} from "../src/DevMsftFeeRouter.sol";
import {MsftHolderDistributor} from "../src/MsftHolderDistributor.sol";

/// @dev Deploy DEVS / MSFT flywheel on Robinhood Chain (4663).
///
/// export ROBINHOOD_RPC_URL=https://rpc.mainnet.chain.robinhood.com
/// export DEPLOYER_KEY=0x...
/// export DEV_TOKEN=0x80Db362eAB104Ec378E19D0a3dCD5E84Bafd4bA3
/// export MSFT_TOKEN=0xe93237C50D904957Cf27E7B1133b510C669c2e74
///
/// forge script script/DeployDevMsft.s.sol --rpc-url $ROBINHOOD_RPC_URL --broadcast --private-key $DEPLOYER_KEY --skip-simulation --slow
///
/// After deploy:
/// 1. Transfer Doppler fee beneficiary to DEV_MSFT_ROUTER
/// 2. Claim accrued fees to the router, then call route()
contract DeployDevMsft is Script {
    address internal constant DEFAULT_DEV_TOKEN = 0x80Db362eAB104Ec378E19D0a3dCD5E84Bafd4bA3;
    address internal constant DEFAULT_MSFT_TOKEN = 0xe93237C50D904957Cf27E7B1133b510C669c2e74;
    address internal constant DEFAULT_LOCK_VAULT = 0xeFC8591519a2D8885C1b62C7de84ce906F22Fa78;
    address internal constant DEFAULT_OWNER = 0x374D91a5674Fa7Cf86E725093b5848b97e1e13b4;
    address internal constant DEFAULT_KEEPER = 0x6eb052b25399809F858Dc1B69b8Ff9225aE44b54;
    /// @dev Same 69-year duration used for ThesisFeeSplitter on Robinhood Chain.
    uint256 internal constant DEFAULT_LOCK_SECONDS = 2_175_984_000;

    function run() external {
        address owner = vm.envOr("PAYOUT_OWNER", DEFAULT_OWNER);
        address keeper = vm.envOr("PAYOUT_KEEPER", DEFAULT_KEEPER);
        address devToken = vm.envOr("DEV_TOKEN", DEFAULT_DEV_TOKEN);
        address msftToken = vm.envOr("MSFT_TOKEN", DEFAULT_MSFT_TOKEN);
        address lockVault = vm.envOr("LOCK_VAULT", DEFAULT_LOCK_VAULT);
        uint256 lockSeconds = vm.envOr("LOCK_SECONDS", DEFAULT_LOCK_SECONDS);

        vm.startBroadcast();
        MsftHolderDistributor distributor = new MsftHolderDistributor(owner, keeper);
        DevMsftFeeRouter router = new DevMsftFeeRouter(devToken, msftToken, address(distributor), lockVault, lockSeconds);
        vm.stopBroadcast();

        require(address(router) != address(0), "router deploy failed");
        require(address(distributor) != address(0), "distributor deploy failed");

        console.log("CHAIN_ID", block.chainid);
        console.log("DEV_TOKEN", devToken);
        console.log("MSFT_TOKEN", msftToken);
        console.log("DEV_MSFT_ROUTER", address(router));
        console.log("MSFT_HOLDER_DISTRIBUTOR", address(distributor));
        console.log("LOCK_VAULT", lockVault);
        console.log("LOCK_SECONDS", lockSeconds);
        console.log("OWNER", owner);
        console.log("KEEPER", keeper);
    }
}
