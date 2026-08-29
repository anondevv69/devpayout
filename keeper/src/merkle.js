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

export function allocations(holders, total, payoutAmount) {
  if (total === 0n) return [];
  const out = [];
  for (const h of holders) {
    const amt = (payoutAmount * h.amt) / total;
    if (amt > 0n) out.push({ who: h.who, amt });
  }
  return out;
}
