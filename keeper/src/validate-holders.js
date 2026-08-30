/**
 * List DEVS holders Blockscout-style (balanceOf > 0), excluding pool(s) only.
 *
 * Usage (from keeper/):
 *   DEV_TOKEN=0x80Db... POOL=0x8366... node src/validate-holders.js
 */
import { createPublicClient, http, getAddress } from "viem";
import { buildSkipSet, snapshotHolders } from "./holders.js";

const robinhood = {
  id: 4663,
  name: "Robinhood Chain",
  nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.mainnet.chain.robinhood.com"] } },
};

function envAddr(name, fallback = "") {
  const v = String(process.env[name] || fallback).trim();
  if (!v) throw new Error(`missing ${name}`);
  return getAddress(v.toLowerCase());
}

async function main() {
  const rpc = process.env.ROBINHOOD_RPC_URL || "https://rpc.mainnet.chain.robinhood.com";
  const client = createPublicClient({ chain: robinhood, transport: http(rpc) });
  const dev = envAddr("DEV_TOKEN", "0x80Db362eAB104Ec378E19D0a3dCD5E84Bafd4bA3");
  const pool = process.env.POOL || "0x8366a39cc670b4001a1121b8f6a443a643e40951";
  const skip = buildSkipSet({ pool, extra: String(process.env.EXCLUDE || "").split(",") });
  const checkpoint = await client.getBlockNumber();

  const { holders, total, balanceBlock, useLatest } = await snapshotHolders(client, dev, checkpoint, skip);
  console.log("validate-holders", {
    token: dev,
    checkpoint: checkpoint.toString(),
    balanceBlock: balanceBlock?.toString(),
    useLatest,
    count: holders.length,
    totalDevs: total.toString(),
  });
  for (const h of holders) {
    const pct = Number((h.amt * 10000n) / total) / 100;
    console.log(`${h.who},${(Number(h.amt) / 1e18).toFixed(6)},${pct.toFixed(4)}%`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
