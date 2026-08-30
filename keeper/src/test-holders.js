/**
 * Holder refresh smoke test — no chain txs, no KEEPER_KEY required.
 * Usage: npm run test-holders
 */
import { prepareHolderSnapshot } from "./blockscout.js";
import { buildSkipSet } from "./holders.js";
import { getAddress } from "viem";

async function main() {
  const dev = getAddress(
    String(process.env.DEV_TOKEN || "0x80Db362eAB104Ec378E19D0a3dCD5E84Bafd4bA3").trim().toLowerCase(),
  );
  const pool = process.env.POOL || "0x8366a39cc670b4001a1121b8f6a443a643e40951";
  const skip = buildSkipSet({ pool });

  const prep = await prepareHolderSnapshot(dev);
  const holders = prep.holders || [];
  const eligible = holders.filter((h) => !skip.has(h.who.toLowerCase()));

  console.log("test-holders", {
    source: prep.source,
    path: prep.path,
    total: holders.length,
    eligible,
    pool,
  });

  if (eligible.length < 100) {
    console.error("FAIL: expected ~443 eligible holders, got", eligible.length);
    process.exit(1);
  }
  console.log("PASS");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
