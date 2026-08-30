# devpayout

Doppler fee flywheel for **DEVS** on Robinhood Chain (`4663`):

- **DEVS** trading fees → locked 69 years in `TimeLockVault`
- **MSFT** paired fees → daily equal split to every DEVS holder (1 share each)

Same pattern as Bankr Prompt on Base; this repo is standalone (contracts + Railway keeper).

## Contracts

| Contract | Role |
|----------|------|
| `DevMsftFeeRouter` | Doppler beneficiary — `claimDoppler()` + `route()` |
| `MsftHolderDistributor` | Daily MSFT holder rounds (Merkle `payBatch`) |

## Deploy

```bash
git clone --recurse-submodules https://github.com/anondevv69/devpayout.git
cd devpayout
# If you already cloned without submodules:
# git submodule update --init --recursive

export ROBINHOOD_RPC_URL=https://rpc.mainnet.chain.robinhood.com
export DEPLOYER_KEY=0x...
export DEV_TOKEN=0x80Db362eAB104Ec378E19D0a3dCD5E84Bafd4bA3
export MSFT_TOKEN=0xe93237C50D904957Cf27E7B1133b510C669c2e74
export PAYOUT_OWNER=0x374D91a5674Fa7Cf86E725093b5848b97e1e13b4
export PAYOUT_KEEPER=0x6eb052b25399809F858Dc1B69b8Ff9225aE44b54

forge script script/DeployDevMsft.s.sol \
  --rpc-url $ROBINHOOD_RPC_URL \
  --broadcast \
  --private-key $DEPLOYER_KEY \
  --skip-simulation --slow
```

Save `DEV_MSFT_ROUTER` and `MSFT_HOLDER_DISTRIBUTOR`.

## Handoff (one-time)

1. Transfer Doppler fee beneficiary → `DEV_MSFT_ROUTER` (Bankr UI or API)
2. Set Railway env vars (`keeper/.env.example`)
3. Deploy Railway from this repo (new project, root = repo root)
4. Cron runs daily (`0 0 * * *` UTC): claim → route → snapshot → pay

## Railway

New Railway project → connect `anondevv69/devpayout` → root directory `/` (default).

| Var | What |
|-----|------|
| `KEEPER_KEY` | `0x6eb0…` keeper wallet |
| `DEV_MSFT_ROUTER` | deployed router |
| `MSFT_HOLDER_DISTRIBUTOR` | deployed distributor |
| `POOL` | LP/pool address to exclude from snapshots |
| `BLOCKSCOUT_API_KEY` | Free key from [dev.blockscout.com](https://dev.blockscout.com) — required for holder auto-refresh |
| `BLOCKSCOUT_CHAIN_ID` | `4663` (Robinhood Chain) |
| `HOLDERS_CACHE_PATH` | `/data/holders.csv` on Railway volume (optional) |

## Tests

```bash
forge test
cd keeper && npm ci
```

## Verify on Blockscout

Robinhood Chain uses **Blockscout** (not Etherscan). Run from your Mac in the repo:

```bash
chmod +x script/verify.sh
./script/verify.sh
```

Or manually:

```bash
forge verify-contract 0x6Abb1E02903ea1a8Cd7F9A148E66D3cbD6cb4e69 \
  src/MsftHolderDistributor.sol:MsftHolderDistributor \
  --chain-id 4663 \
  --verifier blockscout \
  --verifier-url https://robinhoodchain.blockscout.com/api/ \
  --constructor-args $(cast abi-encode "constructor(address,address)" \
    0x374D91a5674Fa7Cf86E725093b5848b97e1e13b4 \
    0x6eb052b25399809F858Dc1B69b8Ff9225aE44b54) \
  --watch

forge verify-contract 0x22492f09e63f6893b0a16F14dd5aDA5CbedC5407 \
  src/DevMsftFeeRouter.sol:DevMsftFeeRouter \
  --chain-id 4663 \
  --verifier blockscout \
  --verifier-url https://robinhoodchain.blockscout.com/api/ \
  --constructor-args $(cast abi-encode "constructor(address,address,address,address,uint256)" \
    0x80Db362eAB104Ec378E19D0a3dCD5E84Bafd4bA3 \
    0xe93237C50D904957Cf27E7B1133b510C669c2e74 \
    0x6Abb1E02903ea1a8Cd7F9A148E66D3cbD6cb4e69 \
    0xeFC8591519a2D8885C1b62C7de84ce906F22Fa78 \
    2175984000) \
  --watch
```

Compiler settings must match deploy: **Solidity 0.8.26**, **optimizer on (200 runs)**, **via_ir = true** (see `foundry.toml`).

**Manual fallback:** open each contract on Blockscout → **Contract** tab → **Verify & publish** → paste source + constructor args above.

## Token constants

| | Address |
|--|---------|
| DEVS | `0x80Db362eAB104Ec378E19D0a3dCD5E84Bafd4bA3` |
| MSFT | `0xe93237C50D904957Cf27E7B1133b510C669c2e74` |
| Lock vault | `0xeFC8591519a2D8885C1b62C7de84ce906F22Fa78` |
| Doppler initializer | `0x4e3468951D49f2EEa976eD0D6e75fFCb44a9a544` |
