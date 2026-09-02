# devpayout

**Project B — Holder drip Lite** for Bankr tokens on Robinhood Chain (`4663`).

Per token: Doppler fees → router → lock meme / push paired RWA to holders (minus **10%** platform fee on new `DripFeeRouter` deploys).

Grow later into Pay Me Dividends Hub (Project A). This repo is the drip product.

## Two phases for every user

1. **Test** — send paired RWA to `distributor` → run a drip
2. **Automate** — retarget Doppler fee beneficiary → `router` → shared 30m keeper

Bankr skill: [`skills/enable-holder-drips/`](./skills/enable-holder-drips/)

## Architecture

```text
Bankr skill → API (Railway SERVICE=api)
                 → register drip in /data/drips.json
Keeper cron (*/30) SERVICE=keeper DRIP_MODE=all
                 → claim/route/pay for each automated drip
```

Users never configure Railway. Mount a **persistent volume at `/data`** on both services (shared volume preferred).

## Contracts

| Contract | Role |
|----------|------|
| `DripFactory` | `createDrip(meme, paired)` → distributor + fee router (10%) |
| `DripFeeRouter` | claim Doppler, lock meme, skim 10%, send RWA to distributor |
| `HolderDistributor` | Merkle push rounds to holders |
| `DevMsftFeeRouter` / `MsftHolderDistributor` | Legacy DEVS/bits deploys (no onchain fee skim) |

## Fix stuck locked round (bits round 1)

If cron logs `resume locked round 1 0 / 21` then crashes:

1. Attach Railway volume at `/data`
2. Recover merkle: `ROUND_ID=1 … node keeper/src/recover-round-merkle.js` into `/data/rounds/`
3. Or set `SKIP_ROUND_IDS=1` and fund a **new** test drip (round 1 funds stay locked in that round)

Keeper now prepares a Robinscan snapshot before resume so rebuild can succeed when the root still matches.

## Deploy factory

```bash
export ROBINHOOD_RPC_URL=https://rpc.mainnet.chain.robinhood.com
export DEPLOYER_KEY=0x...
export PLATFORM_FEE_BPS=1000
export TREASURY=0x374d91a5674fa7cf86e725093b5848b97e1e13b4
export PAYOUT_KEEPER=0x6eb052b25399809F858Dc1B69b8Ff9225aE44b54

forge script script/DeployDripFactory.s.sol \
  --rpc-url $ROBINHOOD_RPC_URL \
  --broadcast --private-key $DEPLOYER_KEY --skip-simulation --slow
```

Then:

```bash
cast send $DRIP_FACTORY "createDrip(address,address)" $MEME $PAIRED \
  --private-key $DEPLOYER_KEY --rpc-url $ROBINHOOD_RPC_URL
```

## API

```bash
SERVICE=api npm run start:api
# GET  /v1/platform
# POST /v1/drips          { memeToken, pairedToken, router, distributor, ... }
# POST /v1/drips/:id/test
# POST /v1/drips/:id/automate { currentBeneficiary }
```

## Railway (two services, one repo)

| Service | Env | Cron |
|---|---|---|
| **api** | `SERVICE=api` | none (web) |
| **keeper** | `SERVICE=keeper`, `DRIP_MODE=all`, `KEEPER_KEY`, volume `/data` | `*/30 * * * *` |

Seed registry: copy `keeper/fixtures/drips.example.json` → `/data/drips.json` on the volume.

## Legacy bits addresses

| | Address |
|--|---------|
| bits | `0xD96CC6ab8322D3E2DE735780146C1Af5fa874BA3` |
| DDOG | `0x27c99fBde9D0d2AA4f4Bfb4943f237843DdF6958` |
| bits router | `0x1d2857d7178c0496F30Af97b36d45ECF659bb29E` |
| bits distributor | `0x4a0ae0e0E9e52Caa0bE8b7556815E64F9547F1E8` |
| Keeper | `0x6eb052b25399809F858Dc1B69b8Ff9225aE44b54` |

## Tests

```bash
forge test
```
