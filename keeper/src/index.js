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
import { claimDopplerIfAvailable } from "./doppler.js";
import { prepareHolderSnapshot } from "./blockscout.js";
import { findOpenCheckpoint, snapshotCheckpoint } from "./checkpoint.js";
import { assertEligibleHolderCount, assertHolderPrep } from "./holders-guard.js";
import { buildSkipSet, snapshotHolders } from "./holders.js";
import { allocationSummary, allocations, buildMerkle } from "./merkle.js";

const BATCH = Number(process.env.PAY_BATCH_SIZE || "40");
const CHECKPOINT_LAGS = [128n, 256n, 512n, 1024n];
const ARB_SYS = "0x0000000000000000000000000000000000000064";
const arbSysAbi = parseAbi(["function arbBlockNumber() view returns (uint256)"]);
const PHASE_OPEN = 0;
const PHASE_LOCKED = 1;

const robinhood = {
  id: 4663,
  name: "Robinhood Chain",
  nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.mainnet.chain.robinhood.com"] } },
};

const routerAbi = parseAbi([
  "function route() returns (uint256 devAmount, uint256 msftAmount, uint256 lockId)",
  "function routeToken(address token) returns (uint256 amount)",
]);
const distributorAbi = parseAbi([
  "function roundCount() view returns (uint256)",
  "function openRound(address payoutToken, address holderToken, uint64 checkpointBlock) returns (uint256 roundId)",
  "function absorbBalance(uint256 roundId) returns (uint256 added)",
  "function lockRound(uint256 roundId, bytes32 merkleRoot, uint32 recipientCount)",
  "function payBatch(uint256 roundId, address[] recipients, uint256[] amounts, bytes32[][] proofs)",
  "function isComplete(uint256 roundId) view returns (bool)",
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

function envMaybeAddr(name) {
  const v = String(process.env[name] || "").trim();
  return v ? getAddress(v.toLowerCase()) : "";
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

function isNothingToRoute(err) {
  const msg = String(err?.shortMessage || err?.message || err?.cause?.signature || err);
  return msg.includes("NothingToRoute") || msg.includes("0x37f4322d");
}

function isZeroAmount(err) {
  const msg = String(err?.shortMessage || err?.message || err);
  return msg.includes("ZeroAmount") || msg.includes("0x1f2a2005");
}

async function tokenBalance(publicClient, token, holder) {
  return publicClient.readContract({
    address: getAddress(token),
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [getAddress(holder)],
  });
}

async function readRoundInfo(publicClient, distributor, roundId) {
  return publicClient.readContract({
    address: distributor,
    abi: distributorAbi,
    functionName: "roundInfo",
    args: [roundId],
  });
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
      // not our event
    }
  }
  return null;
}

async function routeFees(wallet, publicClient, router) {
  if (dryRun()) {
    console.log("dryRun route()");
    return;
  }
  try {
    const hash = await wallet.writeContract({
      address: router,
      abi: routerAbi,
      functionName: "route",
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    console.log("route", hash, receipt.status);
  } catch (e) {
    if (!isNothingToRoute(e)) {
      const msg = String(e?.shortMessage || e?.message || e);
      console.log("route skipped:", msg);
    }
  }
}

async function findActiveRound(publicClient, distributor, msftToken) {
  const count = await publicClient.readContract({
    address: distributor,
    abi: distributorAbi,
    functionName: "roundCount",
  });
  for (let roundId = count - 1n; roundId >= 0n; roundId--) {
    const info = await readRoundInfo(publicClient, distributor, roundId);
    if (getAddress(info[0]) !== getAddress(msftToken)) continue;
    const phase = Number(info[8]);
    const paidCount = Number(info[4]);
    const recipientCount = Number(info[3]);
    if (phase === PHASE_OPEN) {
      return { roundId, phase, info, paidCount, recipientCount };
    }
    if (phase === PHASE_LOCKED && paidCount < recipientCount) {
      return { roundId, phase, info, paidCount, recipientCount };
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
    console.log("payBatch", hash, "paid", slice.length);
  }
}

/** L2 height on Robinhood Chain. `eth_blockNumber` / ArbSys — not `block.number` in Solidity. */
async function getChainBlockNumber(publicClient) {
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

async function openRoundForDistributor(wallet, publicClient, distributor, msftToken, devToken, from) {
  const useL1 = process.env.OPEN_CHECKPOINT || process.env.L1_CHECKPOINT_MAX;
  if (useL1 || process.env.DISTRIBUTOR_USE_L1_CHECKPOINT === "1") {
    const checkpoint = await findOpenCheckpoint(publicClient, distributor, msftToken, devToken, from);
    const hash = await wallet.writeContract({
      address: distributor,
      abi: distributorAbi,
      functionName: "openRound",
      args: [msftToken, devToken, checkpoint],
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    console.log("openRound", hash, "checkpoint L1", checkpoint.toString());
    let roundId = roundIdFromReceipt(receipt);
    if (roundId === null) {
      const count = await publicClient.readContract({
        address: distributor,
        abi: distributorAbi,
        functionName: "roundCount",
      });
      roundId = count - 1n;
    }
    return { roundId, checkpoint };
  }
  return openRoundWithLag(wallet, publicClient, distributor, msftToken, devToken);
}

async function openRoundWithLag(wallet, publicClient, distributor, msftToken, devToken) {
  for (const lag of CHECKPOINT_LAGS) {
    const block = await getChainBlockNumber(publicClient);
    const checkpoint = block > lag ? block - lag : 0n;
    try {
      const hash = await wallet.writeContract({
        address: distributor,
        abi: distributorAbi,
        functionName: "openRound",
        args: [msftToken, devToken, checkpoint],
      });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      console.log("openRound", hash, "checkpoint", checkpoint.toString(), "lag", lag.toString());
      let roundId = roundIdFromReceipt(receipt);
      if (roundId === null) {
        const count = await publicClient.readContract({
          address: distributor,
          abi: distributorAbi,
          functionName: "roundCount",
        });
        roundId = count - 1n;
      }
      return { roundId, checkpoint };
    } catch (e) {
      const msg = String(e?.shortMessage || e?.message || e);
      if (msg.includes("BadCheckpoint") || msg.includes("0x4e117408")) {
        console.log("openRound BadCheckpoint at lag", lag.toString());
        continue;
      }
      throw e;
    }
  }
  throw new Error("openRound failed: BadCheckpoint after lag retries");
}

async function rebuildMerkle(publicClient, distributor, roundId, info, payoutAmount) {
  const checkpoint = BigInt(info[2]);
  const holderToken = getAddress(info[1]);
  const skip = buildSkipSet({
    pool: envMaybeAddr("POOL"),
    extra: String(process.env.EXCLUDE || "").split(","),
  });
  const { holders, total } = await snapshotHolders(publicClient, holderToken, checkpoint, skip);
  const summary = allocationSummary(holders, total, payoutAmount);
  console.log("allocation", summary);
  const entries = allocations(holders, total, payoutAmount, summary.mode);
  if (entries.length === 0) throw new Error("no eligible holders at checkpoint");
  assertEligibleHolderCount(entries.length, "lockRound");
  const merkle = buildMerkle(entries);
  return { merkle, holders: entries.length, checkpoint };
}

export async function run() {
  const transport = makeTransport();
  const account = privateKeyToAccount(key());
  const publicClient = createPublicClient({ chain: robinhood, transport });
  const wallet = createWalletClient({ account, chain: robinhood, transport });

  const router = envAddr("DEV_MSFT_ROUTER");
  const distributor = envAddr("MSFT_HOLDER_DISTRIBUTOR");
  const devToken = envMaybeAddr("DEV_TOKEN") || getAddress("0x80Db362eAB104Ec378E19D0a3dCD5E84Bafd4bA3");
  const msftToken = envMaybeAddr("MSFT_TOKEN") || getAddress("0xe93237C50D904957Cf27E7B1133b510C669c2e74");

  console.log("keeper", account.address);
  console.log("dryRun", dryRun());
  console.log("router", router);
  console.log("distributor", distributor);
  console.log("dev", devToken);
  console.log("msft", msftToken);

  const holderPrep = await prepareHolderSnapshot(devToken);
  const skip = buildSkipSet({
    pool: envMaybeAddr("POOL"),
    extra: String(process.env.EXCLUDE || "").split(","),
  });
  const eligibleCount = assertHolderPrep(holderPrep, skip, "pre-tx");
  console.log("holders", {
    source: holderPrep.source,
    count: holderPrep.holders?.length ?? 0,
    eligible: eligibleCount,
    path: holderPrep.path,
  });

  if (!dryRun()) {
    try {
      await claimDopplerIfAvailable(publicClient, wallet, router, devToken);
    } catch (e) {
      console.log("doppler claim skipped:", String(e?.shortMessage || e?.message || e));
    }
    await routeFees(wallet, publicClient, router);
  } else {
    console.log("dryRun doppler claim + route");
  }

  const active = await findActiveRound(publicClient, distributor, msftToken);
  if (active?.phase === PHASE_LOCKED) {
    const payoutAmount = BigInt(active.info[5]);
    const lockedRoot = active.info[7];
    console.log("resume locked round", active.roundId.toString(), active.paidCount, "/", active.recipientCount);
    const { merkle } = await rebuildMerkle(publicClient, distributor, active.roundId, active.info, payoutAmount);
    if (merkle.root !== lockedRoot) {
      throw new Error(`merkle root mismatch on resume: expected ${lockedRoot}, got ${merkle.root}`);
    }
    if (!dryRun()) {
      await payAll(wallet, publicClient, distributor, active.roundId, merkle, active.paidCount);
    }
    console.log("done resume round", active.roundId.toString());
    return;
  }

  if (active?.phase === PHASE_OPEN) {
    console.log("resume open round", active.roundId.toString());
    if (!dryRun()) {
      try {
        const absorbHash = await wallet.writeContract({
          address: distributor,
          abi: distributorAbi,
          functionName: "absorbBalance",
          args: [active.roundId],
        });
        await publicClient.waitForTransactionReceipt({ hash: absorbHash });
        console.log("absorbBalance", absorbHash);
      } catch (e) {
        if (!isZeroAmount(e)) throw e;
        console.log("absorbBalance: nothing new");
      }
    }
    const info = await readRoundInfo(publicClient, distributor, active.roundId);
    const payoutAmount = BigInt(info[5]);
    if (payoutAmount === 0n) {
      console.log("open round has no MSFT yet — waiting for fees");
      return;
    }
    const { merkle, holders, checkpoint } = await rebuildMerkle(
      publicClient,
      distributor,
      active.roundId,
      info,
      payoutAmount,
    );
    console.log("lock", { holders, payout: payoutAmount.toString(), checkpoint: checkpoint.toString() });
    if (dryRun()) return;
    const lockHash = await wallet.writeContract({
      address: distributor,
      abi: distributorAbi,
      functionName: "lockRound",
      args: [active.roundId, merkle.root, holders],
    });
    await publicClient.waitForTransactionReceipt({ hash: lockHash });
    console.log("lockRound", lockHash);
    await payAll(wallet, publicClient, distributor, active.roundId, merkle, 0);
    console.log("done round", active.roundId.toString());
    return;
  }

  if (dryRun()) {
    console.log("dryRun would openRound, absorb, lock, payBatch");
    return;
  }

  const msftOnDistributor = await tokenBalance(publicClient, msftToken, distributor);
  if (msftOnDistributor === 0n) {
    console.log("no MSFT on distributor — claim/route only this run");
    return;
  }

  const { roundId } = await openRoundForDistributor(
    wallet,
    publicClient,
    distributor,
    msftToken,
    devToken,
    account.address,
  );

  const absorbHash = await wallet.writeContract({
    address: distributor,
    abi: distributorAbi,
    functionName: "absorbBalance",
    args: [roundId],
  });
  await publicClient.waitForTransactionReceipt({ hash: absorbHash });
  console.log("absorbBalance", absorbHash);

  const info = await readRoundInfo(publicClient, distributor, roundId);
  const payoutAmount = BigInt(info[5]);
  if (payoutAmount === 0n) {
    console.log("absorb left zero payout");
    return;
  }

  const { merkle, holders, checkpoint } = await rebuildMerkle(
    publicClient,
    distributor,
    roundId,
    info,
    payoutAmount,
  );
  console.log("lock", { holders, payout: payoutAmount.toString(), checkpoint: checkpoint.toString() });

  const lockHash = await wallet.writeContract({
    address: distributor,
    abi: distributorAbi,
    functionName: "lockRound",
    args: [roundId, merkle.root, holders],
  });
  await publicClient.waitForTransactionReceipt({ hash: lockHash });
  console.log("lockRound", lockHash);

  await payAll(wallet, publicClient, distributor, roundId, merkle, 0);
  console.log("done round", roundId.toString());
}

console.log("devpayout-keeper", new Date().toISOString());

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
