"use client";

import { useCallback, useEffect, useRef, useState } from "react";

const RPC_URL = "https://rpc.mainnet.chain.robinhood.com";
const DISTRIBUTOR = "0x6Abb1E02903ea1a8Cd7F9A148E66D3cbD6cb4e69";
const ROUND_COUNT_CALL = "0x127f0b3f";
const ROUND_INFO_SELECTOR = "0x427f0b00";
const ONE_MSFT = 10n ** 18n;
const FULL_HOLDER_THRESHOLD = 100n;
const LATEST_TRANSFERS_URL = "https://robinhoodchain.blockscout.com/address/0x6eb052b25399809F858Dc1B69b8Ff9225aE44b54?tab=txs";

type Round = { id: number; recipientCount: bigint; paidCount: bigint; paidOut: bigint };
type PayoutStats = { lastFullHolderPayout: Round | null; totalPaid: bigint; completedRoundCount: number };

function formatMsft(amount: bigint) {
  if (amount > 0n && amount < 1_000_000_000_000n) return "< 0.000001";
  const whole = amount / ONE_MSFT;
  const fraction = (amount % ONE_MSFT).toString().padStart(18, "0").slice(0, 6).replace(/0+$/, "");
  return `${whole.toLocaleString()}${fraction ? `.${fraction}` : ""}`;
}

function formatUpdatedAt(date: Date) {
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(date);
}

function calldata(selector: string, id: number) {
  return `${selector}${BigInt(id).toString(16).padStart(64, "0")}`;
}

function readWord(result: string, position: number) {
  const start = 2 + position * 64;
  return BigInt(`0x${result.slice(start, start + 64)}`);
}

async function rpc<T>(method: string, params: unknown[]) {
  const response = await fetch(RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = await response.json() as { error?: { message: string }; result?: T };
  if (!response.ok || body.error || body.result === undefined) throw new Error(body.error?.message || "The chain is temporarily unavailable.");
  return body.result;
}

async function getPayoutStats(): Promise<PayoutStats> {
  const countResult = await rpc<string>("eth_call", [{ to: DISTRIBUTOR, data: ROUND_COUNT_CALL }, "latest"]);
  const roundCount = Number(BigInt(countResult));
  const rounds: Round[] = [];

  for (let id = roundCount - 1; id >= 0; id--) {
    const result = await rpc<string>("eth_call", [{ to: DISTRIBUTOR, data: calldata(ROUND_INFO_SELECTOR, id) }, "latest"]);
    const recipientCount = readWord(result, 3);
    const paidCount = readWord(result, 4);
    rounds.push({ id, recipientCount, paidCount, paidOut: readWord(result, 6) });
  }

  const completed = rounds.filter((round) => round.recipientCount > 0n && round.paidCount >= round.recipientCount);
  return {
    lastFullHolderPayout: completed.find((round) => round.recipientCount >= FULL_HOLDER_THRESHOLD && round.paidOut > 0n) || completed[0] || null,
    totalPaid: completed.reduce((total, round) => total + round.paidOut, 0n),
    completedRoundCount: completed.length,
  };
}

export default function PayoutFeed() {
  const [stats, setStats] = useState<PayoutStats | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const hasLoaded = useRef(false);
  const inFlight = useRef(false);

  const load = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    if (!hasLoaded.current) setState("loading");
    try {
      setStats(await getPayoutStats());
      setLastUpdated(new Date());
      hasLoaded.current = true;
      setState("ready");
    } catch {
      if (!hasLoaded.current) setState("error");
    } finally {
      inFlight.current = false;
    }
  }, []);

  useEffect(() => {
    void load();
    const interval = window.setInterval(() => void load(), 60_000);
    return () => window.clearInterval(interval);
  }, [load]);

  return <section className="section payouts" id="payouts">
    <div className="payout-head">
      <div><p className="eyebrow"><span />Onchain payout totals</p><h2>What <i>$MSFT</i><br />has paid.</h2></div>
      <div className="ledger-meta"><span className={state === "ready" ? "ledger-dot" : "ledger-dot waiting"} /> <span>{state === "ready" && lastUpdated ? `Last updated ${formatUpdatedAt(lastUpdated)}` : "Loading payout totals"}</span></div>
    </div>
    <p className="payout-intro">These figures come directly from the holder distributor contract, including every completed batch in each payout round.</p>
    {state === "loading" && <div className="payout-stats loading"><span /><span /></div>}
    {state === "error" && <div className="ledger-empty">Couldn’t reach the payout contract just now. <button onClick={() => void load()}>Try again</button></div>}
    {state === "ready" && stats && <div className="payout-stats">
      <article className="payout-stat latest">
        <p>Last full-holder payout</p>
        <strong>{stats.lastFullHolderPayout ? formatMsft(stats.lastFullHolderPayout.paidOut) : "—"} <i>$MSFT</i></strong>
        {stats.lastFullHolderPayout ? <a className="payout-round-link" href={LATEST_TRANSFERS_URL} target="_blank" rel="noreferrer">Round #{stats.lastFullHolderPayout.id} · {stats.lastFullHolderPayout.recipientCount.toLocaleString()} holders paid <b>View transfers ↗</b></a> : <span>No completed payout round yet</span>}
      </article>
      <article className="payout-stat">
        <p>Total paid out</p>
        <strong>{formatMsft(stats.totalPaid)} <i>$MSFT</i></strong>
        <span>Across {stats.completedRoundCount.toLocaleString()} completed onchain rounds</span>
      </article>
    </div>}
  </section>;
}
