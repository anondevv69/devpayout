import {
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  fallback,
  formatEther,
  getAddress,
  http,
  parseAbi,
} from "viem";
import { pathToFileURL } from "node:url";
import { privateKeyToAccount } from "viem/accounts";
import { nonceManager } from "viem/nonce";
import { claimDopplerIfAvailable } from "./doppler.js";
import { prepareHolderSnapshot } from "./holders-snapshot.js";
import { findOpenCheckpoint, snapshotCheckpoint } from "./checkpoint.js";
import { assertEligibleHolderCount, assertHolderPrep } from "./holders-guard.js";
import { buildSkipSet, snapshotHolders } from "./holders.js";
import { allocationSummary, allocations, buildMerkle } from "./merkle.js";
import { loadHoldersCsv } from "./holders-csv.js";
import { loadRoundMerkle, saveRoundMerkle } from "./merkle-cache.js";
import fs from "node:fs";
import path from "node:path";

const BATCH = Number(process.env.PAY_BATCH_SIZE || "40");
const CHECKPOINT_LAGS = [128n, 256n, 512n, 1024n];

function minPayoutWei() {
  const raw = String(process.env.MIN_PAYOUT_WEI || "1000000000000").trim();
  if (!raw || raw === "0") return 0n;
  return BigInt(raw);
}

function dustRoundLog(roundId, payoutAmount, summary) {
  console.log(
    `dust round ${roundId}: ${payoutAmount} wei, ${summary?.recipients ?? 0} recipients — cannot pay. ` +
      `Set SKIP_ROUND_IDS=${roundId} on Railway (comma-separate ghosts like 11,25). ` +
      `New fees on the router will open the next real round.`,
  );
}
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRateLimited(err) {
  const msg = String(err?.shortMessage || err?.message || err?.details || err?.cause?.message || err);
  return (
    msg.includes("Too Many Requests") ||
    msg.includes("429") ||
    msg.includes("rate limit") ||
    msg.includes("over rate limit")
  );
}

async function withRpcRetry(label, fn, attempts = 5) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (!isRateLimited(e) || i === attempts - 1) throw e;
      const wait = 1000 * (i + 1);
      console.log("rpc retry", label, { attempt: i + 1, wait });
      await sleep(wait);
    }
  }
  throw lastErr;
}

async function readRoundInfo(publicClient, distributor, roundId) {
  return withRpcRetry(`roundInfo(${roundId})`, () =>
    publicClient.readContract({
      address: distributor,
      abi: distributorAbi,
      functionName: "roundInfo",
      args: [roundId],
    }),
  );
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

function skipRoundIds() {
  const raw = String(process.env.SKIP_ROUND_IDS || "").trim();
  if (!raw) return new Set();
  return new Set(
    raw
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean)
      .map((x) => BigInt(x)),
  );
}

async function findActiveRound(publicClient, distributor, msftToken) {
  const skip = skipRoundIds();
  const count = await withRpcRetry("roundCount", () =>
    publicClient.readContract({
      address: distributor,
      abi: distributorAbi,
      functionName: "roundCount",
    }),
  );
  if (count === 0n) return null;

  // SKIP_ROUND_IDS=11 means "abandon that round" — only check the latest round, not history.
  const roundIds =
    skip.size > 0
      ? [count - 1n]
      : (() => {
          const lookback = Math.max(1, Number(process.env.ACTIVE_ROUND_LOOKBACK || "4"));
          const start = count > BigInt(lookback) ? count - BigInt(lookback) : 0n;
          const ids = [];
          for (let id = count - 1n; id >= start; id--) ids.push(id);
          return ids;
        })();

  for (const roundId of roundIds) {
    if (skip.has(roundId)) {
      console.log("skip round", roundId.toString());
      continue;
    }
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

async function assertKeeperGas(publicClient, account, batches = 1) {
  const [balance, gasPrice] = await Promise.all([
    publicClient.getBalance({ address: account.address }),
    publicClient.getGasPrice(),
  ]);
  // ~1.1M gas per 40-recipient payBatch on Robinhood Chain; add headroom for absorb/lock.
  const gasPerBatch = BigInt(process.env.PAY_BATCH_GAS || "1200000");
  const needed = gasPrice * gasPerBatch * BigInt(batches);
  if (balance < needed) {
    throw new Error(
      `keeper low on ETH: have ${formatEther(balance)}, need ~${formatEther(needed)} for ${batches} payBatch tx(s). ` +
        `Send ETH to ${account.address} then re-run.`,
    );
  }
  return { balance, gasPrice };
}

async function payAll(wallet, publicClient, distributor, roundId, merkle, startIndex = 0) {
  const account = wallet.account;
  const remaining = merkle.leaves.length - startIndex;
  const batches = Math.ceil(remaining / BATCH);
  await assertKeeperGas(publicClient, account, batches);

  for (let i = startIndex; i < merkle.leaves.length; i += BATCH) {
    const slice = merkle.leaves.slice(i, i + BATCH);
    const args = [
      roundId,
      slice.map((l) => l.who),
      slice.map((l) => l.amt),
      merkle.proofs.slice(i, i + BATCH),
    ];
    let gas;
    try {
      gas = await publicClient.estimateContractGas({
        account,
        address: distributor,
        abi: distributorAbi,
        functionName: "payBatch",
        args,
      });
    } catch (e) {
      throw new Error(`payBatch gas estimate failed at index ${i}: ${String(e?.shortMessage || e?.message || e)}`);
    }
    const gasLimit = (gas * 130n) / 100n;
    const hash = await wallet.writeContract({
      address: distributor,
      abi: distributorAbi,
      functionName: "payBatch",
      args,
      gas: gasLimit,
    });
    await publicClient.waitForTransactionReceipt({ hash });
    console.log("payBatch", hash, "paid", slice.length, "gas", gasLimit.toString());
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

async function rebuildMerkle(publicClient, _distributor, _roundId, info, payoutAmount) {
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
  if (entries.length === 0) {
    const err = new Error("no eligible holders at checkpoint");
    err.code = "DUST_ROUND";
    err.summary = summary;
    throw err;
  }
  assertEligibleHolderCount(holders.length, "lockRound");
  const merkle = buildMerkle(entries);
  return { merkle, holders: entries.length, checkpoint };
}

async function merkleFromHoldersCsv(csvPath, info, payoutAmount, lockedRoot) {
  if (!csvPath || !fs.existsSync(csvPath)) return null;
  const checkpoint = BigInt(info[2]);
  const holderToken = getAddress(info[1]);
  const skip = buildSkipSet({
    pool: envMaybeAddr("POOL"),
    extra: String(process.env.EXCLUDE || "").split(","),
  });
  const raw = loadHoldersCsv(csvPath);
  const holders = [];
  let total = 0n;
  for (const h of raw) {
    if (skip.has(h.who.toLowerCase())) continue;
    holders.push(h);
    total += h.amt;
  }
  console.log("merkle from csv", { path: csvPath, holders: holders.length, checkpoint: checkpoint.toString() });
  const summary = allocationSummary(holders, total, payoutAmount);
  const entries = allocations(holders, total, payoutAmount, summary.mode);
  const merkle = buildMerkle(entries);
  if (lockedRoot && merkle.root !== lockedRoot) return null;
  return { merkle, holders: entries.length, checkpoint };
}

async function merkleForRound(publicClient, roundId, info, payoutAmount, lockedRoot = null) {
  const cached = loadRoundMerkle(roundId);
  if (cached && (!lockedRoot || cached.root === lockedRoot)) {
    console.log("merkle from cache", { roundId: roundId.toString(), leaves: cached.leaves.length });
    return { merkle: cached, fromCache: true };
  }

  const csvCandidates = [
    `/data/rounds/round-${roundId}-holders.csv`,
    String(process.env.HOLDERS_CSV_PATH || "").trim(),
    String(process.env.HOLDERS_CACHE_PATH || "/data/holders.csv").trim() + ".bak",
    "/data/holders.csv.bak",
  ].filter(Boolean);
  for (const csvPath of [...new Set(csvCandidates)]) {
    const fromCsv = await merkleFromHoldersCsv(csvPath, info, payoutAmount, lockedRoot);
    if (fromCsv) {
      saveRoundMerkle(roundId, fromCsv.merkle, { source: csvPath });
      return { merkle: fromCsv.merkle, fromCache: true };
    }
  }

  const rebuilt = await rebuildMerkle(publicClient, null, roundId, info, payoutAmount);
  if (lockedRoot && rebuilt.merkle.root !== lockedRoot) {
    throw new Error(
      `merkle root mismatch on resume: expected ${lockedRoot}, got ${rebuilt.merkle.root}. ` +
        `Holder snapshot changed since lockRound. Run recover-round-merkle.js or restore round-${roundId}-holders.csv.`,
    );
  }
  return { merkle: rebuilt.merkle, fromCache: false, holders: rebuilt.holders, checkpoint: rebuilt.checkpoint };
}

function archiveHoldersCsv(roundId, csvPath) {
  if (!csvPath || !fs.existsSync(csvPath)) return;
  const dest = `/data/rounds/round-${roundId}-holders.csv`;
  try {
    fs.mkdirSync("/data/rounds", { recursive: true });
    fs.copyFileSync(csvPath, dest);
    console.log("holders archived", dest);
  } catch (e) {
    console.log("holders archive skipped:", String(e?.message || e));
  }
}

/** Prevent two Railway cron containers from racing the same keeper key. */
function acquireKeeperLock() {
  const lockPath = String(process.env.KEEPER_LOCK_PATH || "/data/keeper.lock").trim();
  const staleMs = Number(process.env.KEEPER_LOCK_STALE_MS || String(15 * 60 * 1000));
  try {
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    if (fs.existsSync(lockPath)) {
      const age = Date.now() - fs.statSync(lockPath).mtimeMs;
      if (age < staleMs) {
        const existing = fs.readFileSync(lockPath, "utf8").trim();
        throw new Error(
          `keeper lock held (${lockPath}) age=${Math.round(age / 1000)}s by ${existing || "unknown"}. ` +
            `Another keeper is running with the same key — pause duplicate Railway services/crons.`,
        );
      }
      console.log("keeper lock stale — taking over", { lockPath, ageMs: age });
    }
    fs.writeFileSync(lockPath, `${process.pid}:${new Date().toISOString()}`);
    return () => {
      try {
        if (fs.existsSync(lockPath)) fs.unlinkSync(lockPath);
      } catch {
        // ignore
      }
    };
  } catch (e) {
    if (String(e?.message || e).includes("keeper lock held")) throw e;
    console.log("keeper lock skipped:", String(e?.message || e));
    return () => {};
  }
}

export async function run() {
  const releaseLock = acquireKeeperLock();
  try {
    return await runLocked();
  } finally {
    releaseLock();
  }
}

async function runLocked() {
  const transport = makeTransport();
  const account = privateKeyToAccount({
    privateKey: key(),
    nonceManager,
  });
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

  const active = await findActiveRound(publicClient, distributor, msftToken);

  // Locked rounds must resume from cached merkle when possible.
  // Always prepare a holder snapshot first so rebuildMerkle can fall back if /data cache was lost.
  const holderPrep = await prepareHolderSnapshot(devToken);

  if (active?.phase === PHASE_LOCKED && active.paidCount < active.recipientCount) {
    const payoutAmount = BigInt(active.info[5]);
    const lockedRoot = active.info[7];
    console.log("resume locked round", active.roundId.toString(), active.paidCount, "/", active.recipientCount);
    try {
      const { merkle, fromCache } = await merkleForRound(
        publicClient,
        active.roundId,
        active.info,
        payoutAmount,
        lockedRoot,
      );
      console.log("resume merkle", { fromCache, root: merkle.root });
      if (!fromCache) {
        saveRoundMerkle(active.roundId, merkle, { source: "resume-rebuild", lockedRoot });
        archiveHoldersCsv(active.roundId, holderPrep.path);
      }
      if (!dryRun()) {
        await payAll(wallet, publicClient, distributor, active.roundId, merkle, active.paidCount);
      }
      console.log("done resume round", active.roundId.toString());
      return;
    } catch (e) {
      const msg = String(e?.message || e);
      console.error(
        "locked round resume failed:",
        msg,
        `\nFix: mount a Railway volume at /data, then either:\n` +
          `  1) ROUND_ID=${active.roundId} node keeper/src/recover-round-merkle.js  (write merkle to /data/rounds)\n` +
          `  2) SKIP_ROUND_IDS=${active.roundId} to abandon and open a new round (funds stay in round ${active.roundId})\n`,
      );
      throw e;
    }
  }
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
    if (payoutAmount < minPayoutWei()) {
      dustRoundLog(active.roundId, payoutAmount.toString(), { recipients: 0 });
      return;
    }
    let merkle;
    let holders;
    let checkpoint;
    try {
      ({ merkle, holders, checkpoint } = await rebuildMerkle(
        publicClient,
        distributor,
        active.roundId,
        info,
        payoutAmount,
      ));
    } catch (e) {
      if (e?.code === "DUST_ROUND" || String(e?.message || "").includes("no eligible holders")) {
        dustRoundLog(active.roundId, payoutAmount.toString(), e.summary);
        return;
      }
      throw e;
    }
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
    saveRoundMerkle(active.roundId, merkle, { payout: payoutAmount.toString() });
    archiveHoldersCsv(active.roundId, holderPrep.path);
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
  if (msftOnDistributor < minPayoutWei()) {
    console.log(`distributor balance ${msftOnDistributor} wei below MIN_PAYOUT_WEI — skipping openRound`);
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
  if (payoutAmount < minPayoutWei()) {
    dustRoundLog(roundId, payoutAmount.toString(), { recipients: 0 });
    return;
  }

  let merkle;
  let holders;
  let checkpoint;
  try {
    ({ merkle, holders, checkpoint } = await rebuildMerkle(
      publicClient,
      distributor,
      roundId,
      info,
      payoutAmount,
    ));
  } catch (e) {
    if (e?.code === "DUST_ROUND" || String(e?.message || "").includes("no eligible holders")) {
      dustRoundLog(roundId, payoutAmount.toString(), e.summary);
      return;
    }
    throw e;
  }
  console.log("lock", { holders, payout: payoutAmount.toString(), checkpoint: checkpoint.toString() });

  const lockHash = await wallet.writeContract({
    address: distributor,
    abi: distributorAbi,
    functionName: "lockRound",
    args: [roundId, merkle.root, holders],
  });
  await publicClient.waitForTransactionReceipt({ hash: lockHash });
  console.log("lockRound", lockHash);
  saveRoundMerkle(roundId, merkle, { payout: payoutAmount.toString() });
  archiveHoldersCsv(roundId, holderPrep.path);

  await payAll(wallet, publicClient, distributor, roundId, merkle, 0);
  console.log("done round", roundId.toString());
}

console.log("devpayout-keeper", new Date().toISOString());

// Only auto-run when this file is the process entrypoint.
// run-all.js imports `run` — must not start a second concurrent keeper (nonce races).
if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  run().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
