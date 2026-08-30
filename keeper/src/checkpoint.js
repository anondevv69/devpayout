import { parseAbi } from "viem";

const ARB_SYS = "0x0000000000000000000000000000000000000064";
const BAD_CHECKPOINT = "0x4e117408";

const distributorAbi = parseAbi([
  "function openRound(address payoutToken, address holderToken, uint64 checkpointBlock) returns (uint256 roundId)",
]);
const arbSysAbi = parseAbi(["function arbBlockNumber() view returns (uint256)"]);

export async function l2Block(publicClient) {
  try {
    return await publicClient.readContract({
      address: ARB_SYS,
      abi: arbSysAbi,
      functionName: "arbBlockNumber",
    });
  } catch {
    return publicClient.getBlockNumber();
  }
}

/**
 * OLD MsftHolderDistributor uses block.number (~26M L1), not L2 (~49M).
 * Binary-search the highest checkpoint openRound accepts.
 */
export async function findOpenCheckpoint(publicClient, distributor, msft, dev, from) {
  const override = String(process.env.OPEN_CHECKPOINT || "").trim();
  if (override) return BigInt(override);

  let lo = 1n;
  let hi = BigInt(process.env.L1_CHECKPOINT_MAX || "27000000");
  let best = 0n;

  while (lo <= hi) {
    const mid = (lo + hi) / 2n;
    try {
      await publicClient.simulateContract({
        address: distributor,
        abi: distributorAbi,
        functionName: "openRound",
        args: [msft, dev, mid],
        account: from,
      });
      best = mid;
      lo = mid + 1n;
    } catch (e) {
      const msg = String(e?.shortMessage || e?.message || e);
      if (msg.includes("BadCheckpoint") || msg.includes(BAD_CHECKPOINT)) {
        hi = mid - 1n;
      } else if (msg.includes("Too Many Requests") || msg.includes("429")) {
        await new Promise((r) => setTimeout(r, 2000));
        continue;
      } else {
        throw e;
      }
    }
  }

  if (best === 0n) throw new Error("no valid openRound checkpoint found");
  return best;
}

/** L2 snapshot block for holder list (Blockscout current balances). */
export async function snapshotCheckpoint(publicClient) {
  const l2 = await l2Block(publicClient);
  const lag = BigInt(process.env.SNAPSHOT_LAG || "128");
  return l2 > lag ? l2 - lag : 0n;
}
