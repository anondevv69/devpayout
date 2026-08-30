import { getAddress, parseAbi, parseAbiItem } from "viem";
import { snapshotHoldersFromBlockscout } from "./blockscout.js";
import { requireRobinscan } from "./robinscan.js";

const transferEvent = parseAbiItem(
  "event Transfer(address indexed from, address indexed to, uint256 value)",
);

const erc20Abi = parseAbi(["function balanceOf(address account) view returns (uint256)"]);

/** DEVS first Transfer on Robinhood Chain mainnet. */
export const DEVS_FROM_BLOCK = 49_400_387n;

const CHUNK = BigInt(process.env.LOG_CHUNK_SIZE || "25000");
const MAX_RETRIES = Number(process.env.LOG_MAX_RETRIES || "5");

/**
 * Addresses excluded from MSFT holder payouts.
 * Matches Blockscout holders tab except pool LP address(es).
 */
export function buildSkipSet({ pool, extra = [] } = {}) {
  const pools = [
    pool,
    ...String(process.env.POOL || "")
      .split(",")
      .map((x) => x.trim()),
    ...String(process.env.POOLS || "")
      .split(",")
      .map((x) => x.trim()),
    ...String(process.env.EXCLUDE || "")
      .split(",")
      .map((x) => x.trim()),
    ...extra.map((x) => String(x).trim()),
  ]
    .filter(Boolean)
    .map((x) => x.toLowerCase());

  return new Set(
    [
      "0x0000000000000000000000000000000000000000",
      "0x000000000000000000000000000000000000dead",
      ...pools,
    ].filter(Boolean),
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getLogsSlice(publicClient, token, start, end) {
  let lastErr;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      return await publicClient.getLogs({
        address: token,
        event: transferEvent,
        fromBlock: start,
        toBlock: end,
      });
    } catch (e) {
      lastErr = e;
      const msg = String(e?.shortMessage || e?.message || e);
      if (!msg.includes("timed out") && !msg.includes("timeout") && e?.code !== -32000) {
        throw e;
      }
      const wait = 1000 * (attempt + 1);
      console.log("getLogs retry", { start: start.toString(), end: end.toString(), attempt: attempt + 1, wait });
      await sleep(wait);
    }
  }
  throw lastErr;
}

async function getLogsChunked(publicClient, token, fromBlock, toBlock) {
  const logs = [];
  let start = fromBlock;
  const total = toBlock - fromBlock + 1n;
  let done = 0n;
  while (start <= toBlock) {
    const end = start + CHUNK - 1n > toBlock ? toBlock : start + CHUNK - 1n;
    const slice = await getLogsSlice(publicClient, token, start, end);
    logs.push(...slice);
    done += end - start + 1n;
    if (total > CHUNK * 2n) {
      console.log("getLogs progress", {
        pct: Number((done * 10000n) / total) / 100,
        logs: logs.length,
        to: end.toString(),
      });
    }
    start = end + 1n;
  }
  return logs;
}

function parseFromBlock() {
  const raw = String(process.env.DEV_FROM_BLOCK || "").trim();
  if (!raw) return DEVS_FROM_BLOCK;
  return BigInt(raw);
}

/** Every address that ever sent or received the token (candidate holder list). */
export async function collectParticipants(publicClient, token, toBlock, fromBlock = parseFromBlock()) {
  const start = fromBlock > toBlock ? toBlock : fromBlock;
  const logs = await getLogsChunked(publicClient, token, start, toBlock);
  const participants = new Set();
  for (const log of logs) {
    if (log.args.from) participants.add(log.args.from.toLowerCase());
    if (log.args.to) participants.add(log.args.to.toLowerCase());
  }
  participants.delete("0x0000000000000000000000000000000000000000");
  return participants;
}

async function balanceAt(publicClient, token, who, blockNumber) {
  return publicClient.readContract({
    address: token,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [getAddress(who)],
    blockNumber,
  });
}

async function replayBalances(publicClient, token, checkpoint, skip, fromBlock) {
  const start = fromBlock > checkpoint ? checkpoint : fromBlock;
  const logs = await getLogsChunked(publicClient, token, start, checkpoint);
  const bal = new Map();
  for (const log of logs) {
    const { from, to, value } = log.args;
    if (from) bal.set(from.toLowerCase(), (bal.get(from.toLowerCase()) || 0n) - value);
    if (to) bal.set(to.toLowerCase(), (bal.get(to.toLowerCase()) || 0n) + value);
  }
  const holders = [];
  let total = 0n;
  for (const [who, amt] of bal) {
    if (amt > 0n && !skip.has(who)) {
      holders.push({ who: getAddress(who), amt });
      total += amt;
    }
  }
  holders.sort((a, b) => (a.who < b.who ? -1 : a.who > b.who ? 1 : 0));
  return { holders, total };
}

/**
 * Holder snapshot for MSFT payouts.
 * Prefers explorer index (Robinscan or Blockscout). Falls back to RPC balanceOf on transfer participants.
 */
export async function snapshotHolders(publicClient, token, checkpoint, skip, fromBlock = parseFromBlock()) {
  const source = String(process.env.HOLDERS_SOURCE || "robinscan").toLowerCase();
  const useExplorer = source !== "rpc";

  if (useExplorer) {
    try {
      const raw = await snapshotHoldersFromBlockscout(token);
      const holders = [];
      let total = 0n;
      for (const h of raw) {
        if (skip.has(h.who.toLowerCase())) continue;
        holders.push(h);
        total += h.amt;
      }
      console.log("snapshotHolders", {
        method: source,
        checkpoint: checkpoint.toString(),
        holders: holders.length,
        sourceTotal: raw.length,
      });
      if (holders.length > 0) return { holders, total, balanceBlock: checkpoint, useLatest: true };
    } catch (e) {
      console.log(`${source} snapshot failed:`, String(e?.message || e));
      const strictRobinscan = requireRobinscan();
      const strictBlockscout =
        process.env.REQUIRE_BLOCKSCOUT === "1" ||
        (process.env.REQUIRE_BLOCKSCOUT !== "0" && Boolean(process.env.BLOCKSCOUT_API_KEY));
      if (strictRobinscan || (source === "blockscout" && strictBlockscout)) throw e;
    }
  }

  if (source === "blockscout" && process.env.BLOCKSCOUT_API_KEY) {
    throw new Error("Blockscout holder snapshot required but unavailable — refusing RPC fallback");
  }

  const latest = await publicClient.getBlockNumber();
  const scanTo = checkpoint > latest ? latest : checkpoint;
  const participants = await collectParticipants(publicClient, token, scanTo, fromBlock);

  let balanceBlock = checkpoint;
  let useLatest = false;

  const probe = [...participants].find((a) => !skip.has(a));
  if (probe) {
    try {
      await balanceAt(publicClient, token, probe, checkpoint);
    } catch {
      useLatest = true;
      balanceBlock = latest;
      console.log("snapshotHolders: historical balanceOf unavailable, using latest block", latest.toString());
    }
  }

  console.log("snapshotHolders", {
    method: "balanceOf",
    participants: participants.size,
    balanceBlock: balanceBlock.toString(),
    checkpoint: checkpoint.toString(),
    excludedPools: [...skip].filter((a) => a.startsWith("0x") && a.length === 42).length,
  });

  const holders = [];
  let total = 0n;
  for (const who of participants) {
    if (skip.has(who)) continue;
    let bal;
    try {
      bal = await balanceAt(publicClient, token, who, balanceBlock);
    } catch {
      if (!useLatest) {
        bal = await balanceAt(publicClient, token, who, latest);
      } else {
        throw new Error(`balanceOf failed for ${who}`);
      }
    }
    if (bal > 0n) {
      holders.push({ who: getAddress(who), amt: bal });
      total += bal;
    }
  }

  holders.sort((a, b) => (a.who < b.who ? -1 : a.who > b.who ? 1 : 0));

  if (holders.length === 0) {
    console.log("snapshotHolders: balanceOf found 0 holders, falling back to transfer replay");
    return replayBalances(publicClient, token, checkpoint, skip, fromBlock);
  }

  return { holders, total, balanceBlock, useLatest };
}
