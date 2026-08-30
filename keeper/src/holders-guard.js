/** Abort before lockRound if holder count looks incomplete (RPC fallback, etc.). */
export function minEligibleHolders() {
  const raw = String(process.env.MIN_ELIGIBLE_HOLDERS || "400").trim();
  return Number(raw);
}

export function assertEligibleHolderCount(count, context = "payout") {
  const min = minEligibleHolders();
  if (count < min) {
    throw new Error(
      `${context}: only ${count} eligible holders (need >= ${min}). ` +
        "Aborting — will not route, openRound, or lockRound with a partial wallet list. " +
        "Holder snapshot must return the full eligible set.",
    );
  }
}

/** Call immediately after prepareHolderSnapshot — before any chain txs. */
export function assertHolderPrep(prep, skip, context = "startup") {
  if (!prep?.holders?.length) {
    throw new Error(
      `${context}: holder snapshot is empty (source=${prep?.source ?? "none"}). ` +
        "Aborting before any on-chain transaction.",
    );
  }
  const eligible = prep.holders.filter((h) => !skip.has(h.who.toLowerCase())).length;
  console.log("holder guard", { source: prep.source, total: prep.holders.length, eligible });
  assertEligibleHolderCount(eligible, context);
  return eligible;
}
