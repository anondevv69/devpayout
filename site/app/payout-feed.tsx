"use client";

import { useCallback, useEffect, useRef, useState } from "react";

const RPC_URL = "https://rpc.mainnet.chain.robinhood.com";
const MSFT = "0xe93237C50D904957Cf27E7B1133b510C669c2e74";
const DISTRIBUTOR = "0x6Abb1E02903ea1a8Cd7F9A148E66D3cbD6cb4e69";
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const DISTRIBUTOR_TOPIC = `0x${DISTRIBUTOR.slice(2).toLowerCase().padStart(64, "0")}`;

type RpcLog = { blockNumber: string; data: string; topics: string[]; transactionHash: string };
type Payout = { amount: string; block: number; recipient: string; transactionHash: string };

function short(address: string) {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function formatMsft(hexValue: string) {
  const amount = BigInt(hexValue);
  const whole = amount / 10n ** 18n;
  const fraction = (amount % 10n ** 18n).toString().padStart(18, "0").slice(0, 8).replace(/0+$/, "");
  return `${whole.toLocaleString()}${fraction ? `.${fraction}` : ""}`;
}

function formatUpdatedAt(date: Date) {
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(date);
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

export default function PayoutFeed() {
  const [payouts, setPayouts] = useState<Payout[]>([]);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const hasLoaded = useRef(false);
  const inFlight = useRef(false);

  const load = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    if (!hasLoaded.current) setState("loading");
    try {
      const head = Number.parseInt(await rpc<string>("eth_blockNumber", []), 16);
      const logs = await rpc<RpcLog[]>("eth_getLogs", [{
        fromBlock: `0x${Math.max(0, head - 200_000).toString(16)}`,
        toBlock: "latest",
        address: MSFT,
        topics: [TRANSFER_TOPIC, DISTRIBUTOR_TOPIC],
      }]);
      const newest = logs
        .map((log) => ({
          amount: formatMsft(log.data),
          block: Number.parseInt(log.blockNumber, 16),
          recipient: `0x${log.topics[2].slice(-40)}`,
          transactionHash: log.transactionHash,
        }))
        .sort((a, b) => b.block - a.block)
        .slice(0, 12);
      setPayouts(newest);
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
      <div><p className="eyebrow"><span />Payout ledger</p><h2>Latest <i>$MSFT</i><br />payments.</h2></div>
      <div className="ledger-meta"><span className={state === "ready" ? "ledger-dot" : "ledger-dot waiting"} /> <span>{state === "ready" && lastUpdated ? `Last updated ${formatUpdatedAt(lastUpdated)}` : "Loading payout activity"}</span></div>
    </div>
    <p className="payout-intro">Every row is an MSFT token transfer sent from the payout distributor to a holder. Tap any row to inspect its onchain receipt.</p>
    <div className="ledger" aria-live="polite">
      <div className="ledger-labels"><span>Recipient</span><span>Amount</span><span>Block</span><span>Receipt</span></div>
      {state === "loading" && Array.from({ length: 5 }, (_, index) => <div className="ledger-loading" key={index}><span /><span /><span /><span /></div>)}
      {state === "error" && <div className="ledger-empty">Couldn’t reach the payout ledger just now. <button onClick={() => void load()}>Try again</button></div>}
      {state === "ready" && payouts.length === 0 && <div className="ledger-empty">No payout transfers were found in the recent chain window.</div>}
      {state === "ready" && payouts.map((payout) => <a className="ledger-row" key={`${payout.transactionHash}-${payout.recipient}`} href={`https://robinhoodchain.blockscout.com/tx/${payout.transactionHash}`} target="_blank" rel="noreferrer"><span><b className="recipient-dot" />{short(payout.recipient)}</span><strong>{payout.amount} <i>$MSFT</i></strong><span>#{payout.block.toLocaleString()}</span><span>View ↗</span></a>)}
    </div>
  </section>;
}
