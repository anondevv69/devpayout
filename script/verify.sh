#!/usr/bin/env bash
# Verify devpayout contracts on Robinhood Chain Blockscout.
# Run from repo root on your machine (forge CLI — not from Railway).

set -euo pipefail

VERIFIER_URL="https://robinhoodchain.blockscout.com/api/"
CHAIN_ID=4663

DISTRIBUTOR=0x6Abb1E02903ea1a8Cd7F9A148E66D3cbD6cb4e69
ROUTER=0x22492f09e63f6893b0a16F14dd5aDA5CbedC5407

OWNER=0x374D91a5674Fa7Cf86E725093b5848b97e1e13b4
KEEPER=0x6eb052b25399809F858Dc1B69b8Ff9225aE44b54
DEV_TOKEN=0x80Db362eAB104Ec378E19D0a3dCD5E84Bafd4bA3
MSFT_TOKEN=0xe93237C50D904957Cf27E7B1133b510C669c2e74
LOCK_VAULT=0xeFC8591519a2D8885C1b62C7de84ce906F22Fa78
LOCK_SECONDS=2175984000

echo "==> MsftHolderDistributor"
forge verify-contract "$DISTRIBUTOR" \
  src/MsftHolderDistributor.sol:MsftHolderDistributor \
  --chain-id "$CHAIN_ID" \
  --verifier blockscout \
  --verifier-url "$VERIFIER_URL" \
  --constructor-args "$(cast abi-encode "constructor(address,address)" "$OWNER" "$KEEPER")" \
  --watch

echo "==> DevMsftFeeRouter"
forge verify-contract "$ROUTER" \
  src/DevMsftFeeRouter.sol:DevMsftFeeRouter \
  --chain-id "$CHAIN_ID" \
  --verifier blockscout \
  --verifier-url "$VERIFIER_URL" \
  --constructor-args "$(cast abi-encode "constructor(address,address,address,address,uint256)" "$DEV_TOKEN" "$MSFT_TOKEN" "$DISTRIBUTOR" "$LOCK_VAULT" "$LOCK_SECONDS")" \
  --watch

echo "Done. Check:"
echo "  https://robinhoodchain.blockscout.com/address/$DISTRIBUTOR?tab=contract"
echo "  https://robinhoodchain.blockscout.com/address/$ROUTER?tab=contract"
