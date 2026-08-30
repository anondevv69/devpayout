/**
 * Recover merkle tree for a locked round when holder snapshot drifted.
 * Tries: cached merkle file → archived holders CSV → brute-force missing holders.
 *
 * Usage (from keeper/):
 *   ROUND_ID=11 KEEPER_KEY=0x... node src/recover-round-merkle.js
 */
import fs from "node:fs";
import {
  createPublicClient,
  fallback,
  getAddress,
  http,
  parseAbi,
  parseAbiItem,
} from "viem";
import { buildSkipSet } from "./holders.js";
import { holdersToCsv } from "./holders-csv.js";
import { fetchHoldersFromRobinscan } from "./robinscan.js";
import { allocations, buildMerkle, leafHash } from "./merkle.js";
import { loadRoundMerkle, saveRoundMerkle } from "./merkle-cache.js";
import { loadHoldersCsv } from "./holders-csv.js";

const robinhood = {
  id: 4663,
  name: "Robinhood Chain",
  nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.mainnet.chain.robinhood.com"] } },
};

const transferEvent = parseAbiItem(
  "event Transfer(address indexed from, address indexed to, uint256 value)",
);

const distributorAbi = parseAbi([
  "function roundInfo(uint256 roundId) view returns (address payoutToken, address holderToken, uint64 checkpointBlock, uint32 recipientCount, uint32 paidCount, uint256 payoutAmount, uint256 paidOut, bytes32 merkleRoot, uint8 phase)",
]);

function envAddr(name, fallback) {
  const v = String(process.env[name] || fallback).trim();
  return getAddress(v.toLowerCase());
}

function tryMerkle(holders, skip, payout, lockedRoot, recipientCount) {
  const eligible = holders.filter((h) => !skip.has(h.who.toLowerCase()));
  const total = eligible.reduce((s, h) => s + h.amt, 0n);
  const entries = allocations(eligible, total, payout);
  if (entries.length !== recipientCount) return null;
  const merkle = buildMerkle(entries);
  return merkle.root === lockedRoot ? merkle : null;
}

async function findMissingHolders(publicClient, token, currentSet, lookbackBlocks = 50000n) {
  const latest = await publicClient.getBlockNumber();
  const from = latest > lookbackBlocks ? latest - lookbackBlocks : 0n;
  const logs = await publicClient.getLogs({
    address: token,
    event: transferEvent,
    fromBlock: from,
    toBlock: latest,
  });
  const touched = new Set();
  for (const log of logs) {
    if (log.args.from) touched.add(log.args.from.toLowerCase());
    if (log.args.to) touched.add(log.args.to.toLowerCase());
  }
  const candidates = [];
  const erc20Abi = parseAbi(["function balanceOf(address) view returns (uint256)"]);
  for (const who of touched) {
    if (currentSet.has(who)) continue;
    const bal = await publicClient.readContract({
      address: token,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [getAddress(who)],
    });
    if (bal > 0n) {
      candidates.push({ who: getAddress(who), amt: bal });
      continue;
    }
    // Reconstruct pre-transfer balance from recent logs for this address.
    let net = 0n;
    for (const log of logs) {
      const { from: f, to, value } = log.args;
      if (f?.toLowerCase() === who) net -= value;
      if (to?.toLowerCase() === who) net += value;
    }
    const current = await publicClient.readContract({
      address: token,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [getAddress(who)],
    });
    const prior = current - net;
    if (prior > 0n) candidates.push({ who: getAddress(who), amt: prior });
  }
  return candidates;
}

async function main() {
  const roundId = BigInt(process.env.ROUND_ID || "11");
  const distributor = envAddr("MSFT_HOLDER_DISTRIBUTOR", "0x6Abb1E02903ea1a8Cd7F9A148E66D3cbD6cb4e69");
  const devToken = envAddr("DEV_TOKEN", "0x80Db362eAB104Ec378E19D0a3dCD5E84Bafd4bA3");
  const pool = process.env.POOL || "0x8366a39cc670b4001a1121b8f6a443a643e40951";
  const skip = buildSkipSet({ pool, extra: String(process.env.EXCLUDE || "").split(",") });

  const rpc = process.env.ROBINHOOD_RPC_URL || "https://rpc.mainnet.chain.robinhood.com";
  const publicClient = createPublicClient({
    chain: robinhood,
    transport: http(rpc),
  });

  const info = await publicClient.readContract({
    address: distributor,
    abi: distributorAbi,
    functionName: "roundInfo",
    args: [roundId],
  });
  const lockedRoot = info[7];
  const payout = BigInt(info[5]);
  const recipientCount = Number(info[3]);
  console.log("round", roundId.toString(), {
    lockedRoot,
    payout: payout.toString(),
    recipientCount,
    phase: info[8],
  });

  const cached = loadRoundMerkle(roundId);
  if (cached?.root === lockedRoot) {
    console.log("cached merkle matches — nothing to do");
    return;
  }

  const archived = `/data/rounds/round-${roundId}-holders.csv`;
  if (fs.existsSync(archived)) {
    const holders = loadHoldersCsv(archived);
    const merkle = tryMerkle(holders, skip, payout, lockedRoot, recipientCount);
    if (merkle) {
      saveRoundMerkle(roundId, merkle, { source: "archived-csv" });
      console.log("recovered from archived csv", archived);
      return;
    }
  }

  const manual = String(process.env.HOLDERS_CSV_PATH || "").trim();
  if (manual && fs.existsSync(manual)) {
    const holders = loadHoldersCsv(manual);
    const merkle = tryMerkle(holders, skip, payout, lockedRoot, recipientCount);
    if (merkle) {
      saveRoundMerkle(roundId, merkle, { source: manual });
      console.log("recovered from HOLDERS_CSV_PATH", manual);
      return;
    }
    console.log("HOLDERS_CSV_PATH did not match locked root", { holders: holders.length });
  }

  const current = await fetchHoldersFromRobinscan(devToken);
  const direct = tryMerkle(current, skip, payout, lockedRoot, recipientCount);
  if (direct) {
    saveRoundMerkle(roundId, direct, { source: "robinscan-live" });
    console.log("live robinscan matches");
    return;
  }

  console.log("current robinscan", current.length, "— searching for missing holders...");
  const currentSet = new Set(current.map((h) => h.who.toLowerCase()));
  const candidates = await findMissingHolders(publicClient, devToken, currentSet);
  console.log("candidates", candidates.length);

  // Try adding each single missing holder.
  for (const c of candidates) {
    const trial = [...current, c].sort((a, b) => (a.who < b.who ? -1 : a.who > b.who ? 1 : 0));
    const merkle = tryMerkle(trial, skip, payout, lockedRoot, recipientCount);
    if (merkle) {
      saveRoundMerkle(roundId, merkle, { source: "recovered-single", added: c.who });
      fs.mkdirSync("/data/rounds", { recursive: true });
      fs.writeFileSync(archived, holdersToCsv(trial));
      console.log("recovered by adding", c.who, c.amt.toString());
      return;
    }
  }

  // Try pairs of candidates (small set only).
  if (candidates.length <= 12) {
    for (let i = 0; i < candidates.length; i++) {
      for (let j = i + 1; j < candidates.length; j++) {
        const trial = [...current, candidates[i], candidates[j]].sort((a, b) =>
          a.who < b.who ? -1 : a.who > b.who ? 1 : 0,
        );
        const merkle = tryMerkle(trial, skip, payout, lockedRoot, recipientCount);
        if (merkle) {
          saveRoundMerkle(roundId, merkle, { source: "recovered-pair" });
          fs.mkdirSync("/data/rounds", { recursive: true });
          fs.writeFileSync(archived, holdersToCsv(trial));
          console.log("recovered by adding pair", candidates[i].who, candidates[j].who);
          return;
        }
      }
    }
  }

  throw new Error(
    `could not recover merkle for round ${roundId}. ` +
      `Need holders CSV from lock time (398 holders). ` +
      `Set HOLDERS_CSV_PATH=/path/to/snapshot.csv and re-run.`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
