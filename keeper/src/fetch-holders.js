/**
 * Download current DEVS holders from Robinscan to cache CSV.
 */
import { getAddress } from "viem";
import { downloadHoldersRobinscan } from "./robinscan.js";
import { buildSkipSet } from "./holders.js";

async function main() {
  const token = getAddress(
    String(process.env.DEV_TOKEN || "0x80Db362eAB104Ec378E19D0a3dCD5E84Bafd4bA3").trim().toLowerCase(),
  );
  const pool = process.env.POOL || "0x8366a39cc670b4001a1121b8f6a443a643e40951";
  const { path, holders } = await downloadHoldersRobinscan(token);
  const skip = buildSkipSet({ pool });
  const eligible = holders.filter((h) => !skip.has(h.who.toLowerCase())).length;
  console.log("saved", path, "total", holders.length, "eligible_excl_pool", eligible);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
