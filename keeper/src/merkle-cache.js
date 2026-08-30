import fs from "node:fs";
import path from "node:path";

function roundsDir() {
  return String(process.env.ROUNDS_CACHE_DIR || "/data/rounds").trim();
}

function merklePath(roundId) {
  return path.join(roundsDir(), `round-${roundId}-merkle.json`);
}

function holdersPath(roundId) {
  return path.join(roundsDir(), `round-${roundId}-holders.csv`);
}

/** Persist merkle tree + metadata so locked rounds can resume after holder drift. */
export function saveRoundMerkle(roundId, merkle, meta = {}) {
  const dir = roundsDir();
  fs.mkdirSync(dir, { recursive: true });
  const out = merklePath(roundId);
  const payload = {
    roundId: String(roundId),
    root: merkle.root,
    leaves: merkle.leaves.map((l) => ({ who: l.who, amt: l.amt.toString() })),
    proofs: merkle.proofs,
    savedAt: new Date().toISOString(),
    ...meta,
  };
  fs.writeFileSync(out, JSON.stringify(payload, null, 2));
  console.log("merkle cached", { path: out, leaves: merkle.leaves.length, root: merkle.root });
  return out;
}

export function loadRoundMerkle(roundId) {
  const file = merklePath(roundId);
  if (!fs.existsSync(file)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    const leaves = (data.leaves || []).map((l) => ({
      who: l.who,
      amt: BigInt(l.amt),
      hash: undefined,
    }));
  return {
      root: data.root,
      leaves,
      proofs: data.proofs || [],
      meta: data,
    };
  } catch (e) {
    console.log("merkle cache read failed:", String(e?.message || e));
    return null;
  }
}

export function saveRoundHoldersCsv(roundId, csvText) {
  const dir = roundsDir();
  fs.mkdirSync(dir, { recursive: true });
  const out = holdersPath(roundId);
  fs.writeFileSync(out, csvText);
  console.log("holders csv archived", { path: out });
  return out;
}
