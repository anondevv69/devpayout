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

/**
 * Equal MSFT per DEVS holder — one share each.
 * DEVS balance only determines eligibility (must hold > 0), not payout size.
 * Integer remainder is spread 1 wei across the first `remainder` holders.
 */
export function allocations(holders, _total, payoutAmount) {
  const n = holders.length;
  if (n === 0) return [];
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
