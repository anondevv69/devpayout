import fs from "node:fs";
import path from "node:path";
import { getAddress } from "viem";
import { loadHoldersCsv, parseHoldersCsv } from "./holders-csv.js";

const DEFAULT_INSTANCE = "https://robinhoodchain.blockscout.com";
const DEFAULT_PRO_API = "https://api.blockscout.com";
const DEFAULT_CHAIN_ID = "4663";

function apiKey() {
  return String(process.env.BLOCKSCOUT_API_KEY || process.env.BLOCKSCOUT_KEY || "").trim();
}

function chainId() {
  return String(process.env.BLOCKSCOUT_CHAIN_ID || DEFAULT_CHAIN_ID).trim();
}

function instanceBase() {
  return String(process.env.BLOCKSCOUT_URL || DEFAULT_INSTANCE).replace(/\/$/, "");
}

function proApiBase() {
  return String(process.env.BLOCKSCOUT_PRO_API_URL || DEFAULT_PRO_API).replace(/\/$/, "");
}

function cachePath(token) {
  const custom = String(process.env.HOLDERS_CACHE_PATH || "").trim();
  if (custom) return custom;
  const dir = String(process.env.HOLDERS_CACHE_DIR || ".cache").trim();
  return path.join(dir, `holders-blockscout-${getAddress(token).toLowerCase()}.csv`);
}

function writeCache(token, text) {
  const primary = cachePath(token);
  fs.mkdirSync(path.dirname(primary), { recursive: true });
  fs.writeFileSync(primary, text);
  return primary;
}

function requireBlockscout() {
  if (process.env.REQUIRE_BLOCKSCOUT === "0" || process.env.REQUIRE_BLOCKSCOUT === "false") return false;
  if (process.env.REQUIRE_BLOCKSCOUT === "1") return true;
  return Boolean(apiKey());
}

function authHeaders() {
  const key = apiKey();
  const headers = {
    accept: "application/json,text/csv,*/*",
    "user-agent": "devpayout-keeper/1.0",
  };
  if (key) headers.authorization = `Bearer ${key}`;
  return headers;
}

function withApiKey(url) {
  const key = apiKey();
  if (!key) return url;
  const u = new URL(url);
  u.searchParams.set("apikey", key);
  return u.toString();
}

function holdersCsvUrl(token) {
  const addr = getAddress(token);
  if (apiKey()) {
    return `${proApiBase()}/${chainId()}/api/v2/tokens/${addr}/holders/csv`;
  }
  return `${instanceBase()}/api/v2/tokens/${addr}/holders/csv`;
}

function holdersJsonUrl(token, query = "") {
  const addr = getAddress(token);
  if (apiKey()) {
    return `${proApiBase()}/${chainId()}/api/v2/tokens/${addr}/holders${query}`;
  }
  return `${instanceBase()}/api/v2/tokens/${addr}/holders${query}`;
}

async function fetchText(url) {
  const res = await fetch(withApiKey(url), { headers: authHeaders() });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`fetch ${res.status} ${body.slice(0, 120)}`);
  }
  return res.text();
}

async function fetchJson(url) {
  const res = await fetch(withApiKey(url), { headers: authHeaders() });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`fetch ${res.status} ${body.slice(0, 120)}`);
  }
  return res.json();
}

export async function downloadHoldersCsvFromUrl(token, url) {
  console.log("holders url download", url);
  const text = await fetchText(url);
  const out = writeCache(token, text);
  const holders = parseHoldersCsv(text);
  console.log("holders url cached", { path: out, holders: holders.length });
  return { path: out, holders, text };
}

export async function downloadHoldersCsv(token) {
  const url = holdersCsvUrl(token);
  console.log("blockscout download", apiKey() ? "pro-api" : "instance", url.replace(apiKey(), "proapi_***"));
  const text = await fetchText(url);
  const out = writeCache(token, text);
  const holders = parseHoldersCsv(text);
  console.log("blockscout cached", { path: out, holders: holders.length });
  return { path: out, holders, text };
}

export async function fetchHoldersFromBlockscout(token) {
  let url = holdersJsonUrl(token, "?items_count=50");
  const holders = [];
  let pages = 0;

  while (url) {
    pages++;
    console.log("blockscout page", pages);
    const data = await fetchJson(url);
    for (const item of data.items || []) {
      const who = getAddress(item.address?.hash || item.address_hash);
      const amt = BigInt(item.value || "0");
      if (amt > 0n) holders.push({ who, amt });
    }
    const next = data.next_page_params;
    if (!next) break;
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(next)) {
      if (v !== null && v !== undefined && v !== "") qs.set(k, String(v));
    }
    url = holdersJsonUrl(token, `?${qs.toString()}`);
  }

  holders.sort((a, b) => (a.who < b.who ? -1 : a.who > b.who ? 1 : 0));
  return holders;
}

/** Opt-in Blockscout snapshot — set HOLDERS_SOURCE=blockscout to use. */
export async function prepareBlockscoutSnapshot(token, { storePrepared }) {
  if (!apiKey()) {
    console.log("holders: BLOCKSCOUT_API_KEY not set — get a free key at https://dev.blockscout.com");
  }

  const out = cachePath(token);

  try {
    const { path: p, holders } = await downloadHoldersCsv(token);
    return storePrepared(token, {
      source: apiKey() ? "blockscout-pro-csv" : "blockscout-fresh",
      path: p,
      holders,
    });
  } catch (e) {
    console.log("blockscout csv failed:", String(e?.message || e));
  }

  try {
    const holders = await fetchHoldersFromBlockscout(token);
    return storePrepared(token, {
      source: apiKey() ? "blockscout-pro-json" : "blockscout-json",
      path: null,
      holders,
    });
  } catch (e) {
    console.log("blockscout json failed:", String(e?.message || e));
  }

  const csvUrl = String(process.env.HOLDERS_CSV_URL || "").trim();
  if (csvUrl) {
    try {
      const { path: p, holders } = await downloadHoldersCsvFromUrl(token, csvUrl);
      return storePrepared(token, { source: "csv-url", path: p, holders });
    } catch (e) {
      console.log("holders csv url failed:", String(e?.message || e));
    }
  }

  if (fs.existsSync(out)) {
    const holders = loadHoldersCsv(out);
    console.log("holders: using stale blockscout cache", out, "count", holders.length);
    return storePrepared(token, { source: "blockscout-stale-cache", path: out, holders });
  }

  if (requireBlockscout()) {
    throw new Error("could not fetch Blockscout holders and no cache exists");
  }

  return { source: "none", path: null, holders: null };
}

// Re-export for legacy scripts.
export { loadHoldersCsv, parseHoldersCsv };
