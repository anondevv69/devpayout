/**
 * Rescue MSFT stuck on the OLD MsftHolderDistributor (0x6Abb…).
 *
 * Robinhood's block.number (~26M L1 estimate) != L2 height (~49M).
 * openRound must use an L1-valid checkpoint; holder snapshot uses L2.
 * The contract only verifies the Merkle root on-chain, not the snapshot block.
 *
 * Usage (from keeper/):
 *   KEEPER_KEY=0x... MSFT_HOLDER_DISTRIBUTOR=0x6Abb... node src/rescue-stuck-msft.js
 *
 * Optional: DRY_RUN=1 to preview without sending txs.
 */
import {
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  fallback,
  getAddress,
  http,
  parseAbi,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { buildSkipSet, snapshotHolders } from "./holders.js";
import { prepareHolderSnapshot } from "./holders-snapshot.js";
import { findOpenCheckpoint, snapshotCheckpoint } from "./checkpoint.js";
import { assertEligibleHolderCount, assertHolderPrep } from "./holders-guard.js";
import { allocations, buildMerkle } from "./merkle.js";

const BATCH = Number(process.env.PAY_BATCH_SIZE || "40");

const robinhood = {
  id: 4663,
  name: "Robinhood Chain",
  nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.mainnet.chain.robinhood.com"] } },
};

const PHASE_OPEN = 0;
const PHASE_LOCKED = 1;

const distributorAbi = parseAbi([
  "function roundCount() view returns (uint256)",
  "function openRound(address payoutToken, address holderToken, uint64 checkpointBlock) returns (uint256 roundId)",
  "function absorbBalance(uint256 roundId) returns (uint256 added)",
  "function lockRound(uint256 roundId, bytes32 merkleRoot, uint32 recipientCount)",
  "function payBatch(uint256 roundId, address[] recipients, uint256[] amounts, bytes32[][] proofs)",
  "function roundInfo(uint256 roundId) view returns (address payoutToken, address holderToken, uint64 checkpointBlock, uint32 recipientCount, uint32 paidCount, uint256 payoutAmount, uint256 paidOut, bytes32 merkleRoot, uint8 phase)",
  "event RoundOpened(uint256 indexed roundId, address indexed payoutToken, address indexed holderToken, uint64 checkpointBlock)",
]);
const erc20Abi = parseAbi(["function balanceOf(address account) view returns (uint256)"]);

function env(name, fallback = "") {
  const v = String(process.env[name] || fallback).trim();
  if (!v) throw new Error(`missing ${name}`);
  return v;
}

function envAddr(name, fallback = "") {
  const v = String(process.env[name] || fallback).trim();
  if (!v) throw new Error(`missing ${name}`);
  return getAddress(v.toLowerCase());
}

function key() {
  const raw = env("KEEPER_KEY");
  return raw.startsWith("0x") ? raw : `0x${raw}`;
}

function dryRun() {
  return process.env.DRY_RUN === "1" || process.env.DRY_RUN === "true";
}

function rpcUrls() {
  const custom = String(process.env.ROBINHOOD_RPC_URL || "").trim();
  const fallbacks = ["https://rpc.mainnet.chain.robinhood.com"];
  if (custom && !fallbacks.includes(custom)) return [custom, ...fallbacks];
  return fallbacks;
}

function makeTransport() {
  const urls = [...new Set(rpcUrls())];
  if (urls.length === 1) return http(urls[0]);
  return fallback(urls.map((url) => http(url)));
}

function roundIdFromReceipt(receipt) {
  for (const log of receipt.logs) {
    try {
      const decoded = decodeEventLog({
        abi: distributorAbi,
        data: log.data,
        topics: log.topics,
      });
      if (decoded.eventName === "RoundOpened") return decoded.args.roundId;
    } catch {
      // skip
    }
  }
  return null;
}

async function payAll(wallet, publicClient, distributor, roundId, merkle, startIndex = 0) {
  for (let i = startIndex; i < merkle.leaves.length; i += BATCH) {
    const slice = merkle.leaves.slice(i, i + BATCH);
    const hash = await wallet.writeContract({
      address: distributor,
      abi: distributorAbi,
      functionName: "payBatch",
      args: [
        roundId,
        slice.map((l) => l.who),
        slice.map((l) => l.amt),
        merkle.proofs.slice(i, i + BATCH),
      ],
    });
    await publicClient.waitForTransactionReceipt({ hash });
    console.log("payBatch", hash, "recipients", slice.length);
  }
}

async function main() {
  const transport = makeTransport();
  const account = privateKeyToAccount(key());
  const publicClient = createPublicClient({ chain: robinhood, transport });
  const wallet = createWalletClient({ account, chain: robinhood, transport });

  const distributor = envAddr(
    "MSFT_HOLDER_DISTRIBUTOR",
    "0x6Abb1E02903ea1a8Cd7F9A148E66D3cbD6cb4e69",
  );
  const dev = envAddr("DEV_TOKEN", "0x80Db362eAB104Ec378E19D0a3dCD5E84Bafd4bA3");
  const msft = envAddr("MSFT_TOKEN", "0xe93237C50D904957Cf27E7B1133b510C669c2e74");
  const router = envAddr("DEV_MSFT_ROUTER", "0x22492f09e63f6893b0a16F14dd5aDA5CbedC5407");
  const pool = process.env.POOL || "0x8366a39cc670b4001a1121b8f6a443a643e40951";
  const skip = buildSkipSet({ pool, extra: String(process.env.EXCLUDE || "").split(",") });

  const msftBal = await publicClient.readContract({
    address: msft,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [distributor],
  });
  console.log("rescue", { distributor, msftBal: msftBal.toString(), signer: account.address });

  if (msftBal === 0n) {
    console.log("no MSFT on distributor");
    return;
  }

  const holderPrep = await prepareHolderSnapshot(dev);
  assertHolderPrep(holderPrep, skip, "pre-tx");

  const openCp = await findOpenCheckpoint(publicClient, distributor, msft, dev, account.address);
  const snapshotCp = await snapshotCheckpoint(publicClient);
  console.log("checkpoints", { openRound: openCp.toString(), snapshot: snapshotCp.toString() });

  const roundCount = await publicClient.readContract({
    address: distributor,
    abi: distributorAbi,
    functionName: "roundCount",
  });

  let roundId;
  let payoutAmount = msftBal;
  let skipOpen = false;

  if (roundCount > 0n) {
    roundId = roundCount - 1n;
    const info = await publicClient.readContract({
      address: distributor,
      abi: distributorAbi,
      functionName: "roundInfo",
      args: [roundId],
    });
    const phase = Number(info[8]);
    const funded = BigInt(info[5]);
    if (phase === PHASE_OPEN && funded > 0n) {
      payoutAmount = funded;
      skipOpen = true;
      console.log("resume open round", roundId.toString(), "payout", payoutAmount.toString());
    } else if (phase === PHASE_LOCKED && Number(info[4]) < Number(info[3])) {
      skipOpen = true;
      payoutAmount = funded;
      console.log("resume locked round", roundId.toString(), "paid", info[4], "/", info[3]);
    } else if (phase === PHASE_LOCKED && Number(info[4]) >= Number(info[3])) {
      console.log("last round complete — opening new round", roundId.toString());
    } else if (phase !== PHASE_OPEN) {
      throw new Error(`round ${roundId} not resumable (phase ${phase})`);
    }
  }

  if (dryRun()) {
    const { holders, total } = await snapshotHolders(publicClient, dev, snapshotCp, skip);
    const entries = allocations(holders, total, payoutAmount);
    assertEligibleHolderCount(entries.length, "dryRun");
    console.log("dryRun would pay", entries.length, "holders, total MSFT", payoutAmount.toString());
    return;
  }

  if (!skipOpen) {
    const openHash = await wallet.writeContract({
      address: distributor,
      abi: distributorAbi,
      functionName: "openRound",
      args: [msft, dev, openCp],
    });
    const openRcpt = await publicClient.waitForTransactionReceipt({ hash: openHash });
    roundId = roundIdFromReceipt(openRcpt);
    if (roundId === null) {
      const count = await publicClient.readContract({
        address: distributor,
        abi: distributorAbi,
        functionName: "roundCount",
      });
      roundId = count - 1n;
    }
    console.log("openRound", openHash, "roundId", roundId.toString());

    const absorbHash = await wallet.writeContract({
      address: distributor,
      abi: distributorAbi,
      functionName: "absorbBalance",
      args: [roundId],
    });
    await publicClient.waitForTransactionReceipt({ hash: absorbHash });
    console.log("absorbBalance", absorbHash);
    payoutAmount = msftBal;
  }

  const { holders, total } = await snapshotHolders(publicClient, dev, snapshotCp, skip);
  const entries = allocations(holders, total, payoutAmount);
  if (entries.length === 0) throw new Error("no eligible DEVS holders at snapshot block");
  assertEligibleHolderCount(entries.length, "lockRound");
  const merkle = buildMerkle(entries);
  console.log("snapshot", { holders: entries.length, root: merkle.root, payout: payoutAmount.toString() });

  const info = await publicClient.readContract({
    address: distributor,
    abi: distributorAbi,
    functionName: "roundInfo",
    args: [roundId],
  });
  const phase = Number(info[8]);

  if (phase === PHASE_OPEN) {
    const lockHash = await wallet.writeContract({
      address: distributor,
      abi: distributorAbi,
      functionName: "lockRound",
      args: [roundId, merkle.root, entries.length],
    });
    await publicClient.waitForTransactionReceipt({ hash: lockHash });
    console.log("lockRound", lockHash);
  } else if (merkle.root !== info[7]) {
    throw new Error(`merkle root mismatch: on-chain ${info[7]}, rebuilt ${merkle.root}`);
  }

  await payAll(wallet, publicClient, distributor, roundId, merkle, Number(info[4]));
  console.log("rescue complete round", roundId.toString());
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
