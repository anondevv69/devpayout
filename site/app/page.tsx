import PayoutFeed from "./payout-feed";

const flow = [
  ["01", "Fees arrive", "Trading fees are claimed and routed into the payout flow."],
  ["02", "Holders are checked", "A checkpoint captures eligible DEVS balances on Robinhood Chain."],
  ["03", "MSFT is distributed", "The available MSFT is allocated pro rata and sent in onchain batches."],
];

const addresses = [
  ["DEVS token", "0x80Db362eAB104Ec378E19D0a3dCD5E84Bafd4bA3"],
  ["MSFT token", "0xe93237C50D904957Cf27E7B1133b510C669c2e74"],
];

export default function Home() {
  return <main>
    <div className="video" aria-hidden="true" />
    <div className="wash" /><div className="grain" />
    <header><a className="brand" href="#top" aria-label="DEVS home"><b>$</b>DEVS</a><nav><a href="#payouts">Payouts</a><a href="#mechanics">Mechanics</a><a href="#contracts">Contracts</a></nav></header>
    <section className="hero" id="top">
      <p className="eyebrow"><span />Robinhood Chain · 4663</p>
      <h1>Hold <i>$DEVS</i>.<br />Receive <em>$MSFT</em>.</h1>
      <p className="copy">A fee-powered payout loop: eligible DEVS holders share the MSFT that flows through each completed distribution round.</p>
      <div className="actions"><a className="button primary" href="#payouts">View recent payouts ↓</a><a className="button quiet" href="#mechanics">How it works ↓</a></div>
      <p className="open"><span />Live payout activity · onchain</p>
    </section>
    <section className="statement"><p>DEVS is built around a simple idea</p><strong>Ownership participates.</strong><span>MSFT payouts are funded by collected fees and split by eligible DEVS balance at the distribution checkpoint.</span></section>
    <PayoutFeed />
    <section className="section" id="mechanics">
      <div className="heading"><p className="eyebrow"><span />The payout loop</p><h2>Built to be<br /><i>verifiable.</i></h2></div>
      <div className="flow">{flow.map(([number, title, body]) => <article key={number}><b>{number}</b><h3>{title}</h3><p>{body}</p></article>)}</div>
      <p className="note">The current keeper is configured to run a daily payout cycle. Every payout depends on fees received and a completed onchain round.</p>
    </section>
    <section className="section contracts" id="contracts">
      <div className="heading small"><p className="eyebrow"><span />Onchain identifiers</p><h2>The <i>details.</i></h2></div>
      <div className="cards">{addresses.map(([label, address]) => <article key={label}><p>{label}</p><code>{address}</code><span className="verified">Verified on Robinhood Chain</span></article>)}<article className="chain"><p>Network</p><strong>Robinhood Chain</strong><span>Chain ID 4663</span></article></div>
    </section>
    <section className="source"><p className="eyebrow"><span />Your proof, onchain</p><h2>Payouts you can<br /><i>actually see.</i></h2><a className="button primary" href="#payouts">View payout activity ↑</a></section>
    <footer><a className="brand" href="#top"><b>$</b>DEVS</a><p>DEVS / MSFT · Robinhood Chain</p><p>Information only. Token ownership and payouts involve risk; payout amounts are not guaranteed.</p></footer>
  </main>;
}
