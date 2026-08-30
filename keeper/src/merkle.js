import { encodePacked, keccak256 } from "viem";

export function leafHash(who, amt) {
  return keccak256(encodePacked(["address", "uint256"], [who, amt]));
}

export function hashPair(a, b) {
  return a.toLowerCase() <= b.toLowerCase()
    ? keccak256(encodePacked(["bytes32", "bytes32"], [a, b]))
    : keccak256(encodePacked(["bytes32", "bytes32"], [b, a]));
}

/** Adjacent-pair Merkle tree with sorted pairs (matches MsftHolderDistributor). */
export function buildMerkle(entries) {
  if (entries.length === 0) throw new Error("no leaves");
  const leaves = entries.map((e) => ({
    who: e.who,
    amt: e.amt,
    hash: leafHash(e.who, e.amt),
  }));
  const layers = [leaves.map((l) => l.hash)];
  while (layers[layers.length - 1].length > 1) {
    const prev = layers[layers.length - 1];
    const next = [];
    for (let i = 0; i < prev.length; i += 2) {
      if (i + 1 === prev.length) next.push(prev[i]);
      else next.push(hashPair(prev[i], prev[i + 1]));
    }
    layers.push(next);
  }
  const proofs = leaves.map((_, idx) => {
    const proof = [];
    let i = idx;
    for (let level = 0; level < layers.length - 1; level++) {
      const layer = layers[level];
      const sibling = i % 2 === 0 ? i + 1 : i - 1;
      if (sibling < layer.length) proof.push(layer[sibling]);
      i = Math.floor(i / 2);
    }
    return proof;
  });
  return { root: layers[layers.length - 1][0], leaves, proofs };
}

/** @returns {"equal" | "pro_rata"} */
export function allocationMode() {
  const mode = String(process.env.ALLOCATION_MODE || "pro_rata").toLowerCase();
  if (mode === "equal") return "equal";
  if (mode === "pro_rata" || mode === "prorata" || mode === "pro-rata") return "pro_rata";
  return "pro_rata";
}

/**
 * Pro-rata (default): MSFT weighted by DEVS balance at checkpoint.
 * Equal: one MSFT share per DEVS holder (set ALLOCATION_MODE=equal).
 */
export function allocations(holders, total, payoutAmount, mode = allocationMode()) {
  const n = holders.length;
  if (n === 0) return [];
  if (mode === "pro_rata") {
    if (total === 0n) throw new Error("total DEVS supply is zero");
    return holders
      .map((h) => ({
        who: h.who,
        amt: (h.amt * payoutAmount) / total,
      }))
      .filter((e) => e.amt > 0n);
  }
  const count = BigInt(n);
  const base = payoutAmount / count;
  const rem = payoutAmount % count;
  return holders
    .map((h, i) => ({
      who: h.who,
      amt: base + (BigInt(i) < rem ? 1n : 0n),
    }))
    .filter((e) => e.amt > 0n);
}

export function allocationSummary(holders, total, payoutAmount, mode = allocationMode()) {
  const entries = allocations(holders, total, payoutAmount, mode);
  const allocated = entries.reduce((s, e) => s + e.amt, 0n);
  const dust = payoutAmount - allocated;
  return {
    mode,
    eligible: holders.length,
    recipients: entries.length,
    skippedZero: holders.length - entries.length,
    payoutWei: payoutAmount,
    allocatedWei: allocated,
    dustWei: dust,
  };
}
