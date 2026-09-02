/**
 * Multi-tenant keeper: runs one drip cycle per registered (or env) flywheel.
 *
 * Modes:
 *   DRIP_MODE=single (default) — use DEV_* / MSFT_* env (legacy bits/DEVS)
 *   DRIP_MODE=all — loop /data/drips.json (automated drips only unless INCLUDE_MANUAL=1)
 *   DRIP_ID=... — run one registry drip
 */
import { getAddress } from "viem";
import { run as runSingle } from "./index.js";
import { getDrip, listDrips } from "./drip-registry.js";

function applyDripEnv(drip) {
  process.env.DEV_MSFT_ROUTER = getAddress(drip.router);
  process.env.MSFT_HOLDER_DISTRIBUTOR = getAddress(drip.distributor);
  process.env.DEV_TOKEN = getAddress(drip.memeToken);
  process.env.MSFT_TOKEN = getAddress(drip.pairedToken);
  process.env.HOLDERS_CACHE_PATH =
    process.env.HOLDERS_CACHE_PATH || `/data/holders-${drip.memeToken.slice(2, 10).toLowerCase()}.csv`;
  // Isolate round merkle per drip so concurrent tokens don't collide.
  process.env.ROUNDS_CACHE_DIR = `/data/rounds/${drip.id}`;
}

async function main() {
  const mode = String(process.env.DRIP_MODE || "single").toLowerCase();
  const onlyId = String(process.env.DRIP_ID || "").trim();

  if (onlyId) {
    const drip = getDrip(onlyId);
    if (!drip) throw new Error(`drip_not_found:${onlyId}`);
    console.log("run drip", drip.id, drip.symbol || drip.memeToken);
    applyDripEnv(drip);
    await runSingle();
    return;
  }

  if (mode === "all" || mode === "multi") {
    const includeManual = process.env.INCLUDE_MANUAL === "1" || process.env.INCLUDE_MANUAL === "true";
    const drips = listDrips({ automatedOnly: !includeManual });
    console.log("multi-tenant drips", drips.length, { includeManual });
    if (drips.length === 0) {
      const hasLegacy = Boolean(String(process.env.DEV_MSFT_ROUTER || "").trim());
      if (!hasLegacy) {
        console.log(
          "no drips in /data/drips.json and DEV_MSFT_ROUTER unset — nothing to run. " +
            "Add a drip to the registry or set DEV_MSFT_ROUTER / MSFT_HOLDER_DISTRIBUTOR / DEV_TOKEN / MSFT_TOKEN.",
        );
        return;
      }
      console.log("no drips in registry — falling back to single env flywheel");
      await runSingle();
      return;
    }
    for (const drip of drips) {
      console.log("=== drip", drip.id, drip.symbol || "", drip.memeToken, "===");
      try {
        applyDripEnv(drip);
        await runSingle();
      } catch (e) {
        console.error("drip failed", drip.id, String(e?.message || e));
      }
    }
    return;
  }

  await runSingle();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
