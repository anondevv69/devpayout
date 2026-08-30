/**
 * Holder refresh smoke test — no chain txs, no KEEPER_KEY required.
 * Usage: npm run test-holders
 */
import { prepareHolderSnapshot } from "./holders-snapshot.js";
import { buildSkipSet } from "./holders.js";
import { allocationSummary } from "./merkle.js";
import { getAddress } from "viem";

const SPOT_WALLET = "0xc35b187491ed0bf37913c87ef5b4b084a9580f54";

async function main() {
  const dev = getAddress(
    String(process.env.DEV_TOKEN || "0x80Db362eAB104Ec378E19D0a3dCD5E84Bafd4bA3").trim().toLowerCase(),
  );
  const pool = process.env.POOL || "0x8366a39cc670b4001a1121b8f6a443a643e40951";
  const skip = buildSkipSet({ pool });

  const prep = await prepareHolderSnapshot(dev);
  const holders = prep.holders || [];
  const eligible = holders.filter((h) => !skip.has(h.who.toLowerCase()));
  const spot = eligible.find((h) => h.who.toLowerCase() === SPOT_WALLET.toLowerCase());
  const total = eligible.reduce((s, h) => s + h.amt, 0n);
  const pot = BigInt(Math.round(0.03 * 1e18));
  const summary = allocationSummary(eligible, total, pot, "pro_rata");

  console.log("test-holders", {
    source: prep.source,
    path: prep.path,
    total: holders.length,
    eligible: eligible.length,
    spotWallet: spot ? { who: spot.who, devs: spot.amt.toString() } : null,
    proRataAt003: summary,
    pool,
  });

  if (eligible.length < 380) {
    console.error("FAIL: expected >=380 eligible holders, got", eligible.length);
    process.exit(1);
  }
  if (!spot) {
    console.error("FAIL: spot wallet missing from snapshot", SPOT_WALLET);
    process.exit(1);
  }
  console.log("PASS");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
