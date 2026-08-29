import { getAddress, parseAbiItem } from "viem";

const transferEvent = parseAbiItem(
  "event Transfer(address indexed from, address indexed to, uint256 value)",
);

const CHUNK = 500_000n;

export function buildSkipSet({ router, distributor, pool, extra = [] }) {
  return new Set(
    [
      "0x0000000000000000000000000000000000000000",
      "0x000000000000000000000000000000000000dead",
      router?.toLowerCase(),
      distributor?.toLowerCase(),
      pool?.toLowerCase(),
      ...extra.map((x) => x.trim().toLowerCase()).filter(Boolean),
    ].filter(Boolean),
  );
}

async function getLogsChunked(publicClient, token, fromBlock, toBlock) {
  const logs = [];
  let start = fromBlock;
  while (start <= toBlock) {
    const end = start + CHUNK > toBlock ? toBlock : start + CHUNK;
    const slice = await publicClient.getLogs({
      address: token,
      event: transferEvent,
      fromBlock: start,
      toBlock: end,
    });
    logs.push(...slice);
    start = end + 1n;
  }
  return logs;
}

/** Replay DEVS Transfer logs through `checkpoint` and return positive balances. */
export async function snapshotHolders(publicClient, token, checkpoint, skip) {
  const logs = await getLogsChunked(publicClient, token, 0n, checkpoint);
  const bal = new Map();
  for (const log of logs) {
    const { from, to, value } = log.args;
    if (from && !skip.has(from.toLowerCase())) {
      bal.set(from, (bal.get(from) || 0n) - value);
    }
    if (to && !skip.has(to.toLowerCase())) {
      bal.set(to, (bal.get(to) || 0n) + value);
    }
  }
  const holders = [];
  let total = 0n;
  for (const [who, amt] of bal) {
    if (amt > 0n) {
      holders.push({ who: getAddress(who), amt });
      total += amt;
    }
  }
  holders.sort((a, b) => (a.who < b.who ? -1 : a.who > b.who ? 1 : 0));
  return { holders, total };
}
