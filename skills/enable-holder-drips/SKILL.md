---
name: enable-holder-drips
description: Create a Pay Me Dividends Lite holder drip for a Bankr token on Robinhood Chain. Deploy/register router+distributor, test by sending paired RWA to the distributor, then fully automate by retargeting Doppler fees to the router. Platform takes 10% of each drip.
metadata:
  {
    "clawdbot":
      {
        "emoji": "💧",
        "homepage": "https://github.com/anondevv69/devpayout",
      },
  }
---

# Enable holder drips (Project B — Lite)

Push paired-stock fees to meme holders on a schedule. **Not** the Universal Hub (Project A).

Natural-language triggers:

- "Drip my token fees to holders"
- "Enable holder drips"
- "Test drip then automate"

## Platform

| Setting | Value |
|---|---|
| Fee | **10%** of each paired-RWA drip → treasury |
| Cron | every **30 minutes** (after automate) |
| One-per-RWA | **No** (unlimited while testing) |
| Meme leg | Locked 69y in TimeLockVault |

API base (set after Railway deploy):

```text
DRIP_API_URL=https://<your-devpayout-api>.up.railway.app
```

## Flow (always test first)

### 1. Create / register drip

```http
POST {DRIP_API_URL}/v1/drips
Content-Type: application/json

{
  "memeToken": "0x…",
  "pairedToken": "0x…",
  "router": "0x…",
  "distributor": "0x…",
  "symbol": "bits",
  "pairedSymbol": "DDOG",
  "poolId": "0x…"
}
```

Response includes:

- `distributor` — **send paired RWA here to test**
- `router` — future fee recipient (do **not** retarget yet)
- fee terms + next steps

If the user has no contracts yet: guide them to deploy via `DripFactory.createDrip(meme, paired)` (or you deploy and pass addresses into this POST).

### 2. Test drip

1. User sends a small amount of **paired RWA** (e.g. DDOG) to `distributor`
2. Call:

```http
POST {DRIP_API_URL}/v1/drips/{id}/test
```

3. Confirm holders received push payouts (minus 10% platform fee on **new** fee-router drips)

### 3. Fully automate

```http
POST {DRIP_API_URL}/v1/drips/{id}/automate
Content-Type: application/json

{ "currentBeneficiary": "0x…user-wallet" }
```

Returns Bankr retarget tx → user signs → fees go to **router**.

Shared Railway keeper (`DRIP_MODE=all`) then runs every 30m for all `automated: true` drips.

## Who can use this

Wallet must be (or become) the Doppler fee beneficiary with ≥95% share to automate.

## Must NOT do

- Retarget fees before a successful test drip (unless user insists)
- Promise Universal Hub enrollment / cross-RWA claims (that's Project A)
- Store Bankr API keys server-side
- Tell users to configure Railway themselves

## Product rules

- Test = manual send to distributor
- Automate = retarget to router
- Platform hosts one shared cron for everyone
