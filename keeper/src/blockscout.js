import fs from "node:fs";
import path from "node:path";
import { getAddress } from "viem";

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
  return path.join(dir, `holders-${getAddress(token).toLowerCase()}.csv`);
}

function writeCache(token, text) {
  const primary = cachePath(token);
  try {
    fs.mkdirSync(path.dirname(primary), { recursive: true });
    fs.writeFileSync(primary, text);
    return primary;
  } catch (e) {
    const fallback = path.join(
      String(process.env.HOLDERS_CACHE_DIR || ".cache").trim(),
      `holders-${getAddress(token).toLowerCase()}.csv`,
    );
    console.log("cache write fallback", primary, "->", fallback, String(e?.message || e));
    fs.mkdirSync(path.dirname(fallback), { recursive: true });
    fs.writeFileSync(fallback, text);
    return fallback;
  }
}

/** In-memory holders from the latest prepareHolderSnapshot() call this process. */
let preparedSnapshot = null;

export function getPreparedHolders(token) {
  const addr = getAddress(token);
  if (preparedSnapshot?.token === addr && preparedSnapshot.holders?.length) {
    return preparedSnapshot.holders;
  }
  return null;
}

function requireBlockscout() {
  if (process.env.HOLDERS_SOURCE === "rpc") return false;
  if (process.env.REQUIRE_BLOCKSCOUT === "0" || process.env.REQUIRE_BLOCKSCOUT === "false") return false;
  if (process.env.REQUIRE_BLOCKSCOUT === "1") return true;
  return Boolean(apiKey());
}

function parseWei(value) {
  const raw = String(value ?? "").trim();
  if (!raw || raw === "0") return 0n;
  if (raw.includes(".")) {
    const [whole, frac = ""] = raw.split(".");
    const fracPadded = (frac + "000000000000000000").slice(0, 18);
    return BigInt(whole || "0") * 10n ** 18n + BigInt(fracPadded);
  }
  return BigInt(raw);
}

/** Parse Blockscout "Download CSV" export (HolderAddress,Balance). */
export function parseHoldersCsv(text) {
  const lines = String(text).trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  const holders = [];
  for (const line of lines.slice(1)) {
    const i = line.lastIndexOf(",");
    if (i < 1) continue;
    const who = getAddress(line.slice(0, i).trim());
    const amt = parseWei(line.slice(i + 1).trim());
    if (amt > 0n) holders.push({ who, amt });
  }
  holders.sort((a, b) => (a.who < b.who ? -1 : a.who > b.who ? 1 : 0));
  return holders;
}

export function loadHoldersCsv(filePath) {
  const text = fs.readFileSync(filePath, "utf8");
  return parseHoldersCsv(text);
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

/** PRO API base when key is set; else per-instance explorer URL. */
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

/** Download CSV from a custom URL (e.g. GitHub raw, S3) and save to cache. */
export async function downloadHoldersCsvFromUrl(token, url) {
  console.log("holders url download", url);
  const text = await fetchText(url);
  const out = writeCache(token, text);
  const holders = parseHoldersCsv(text);
  console.log("holders url cached", { path: out, holders: holders.length });
  return { path: out, holders, text };
}

/** Download fresh CSV from Blockscout PRO API (or instance) and save to cache. */
export async function downloadHoldersCsv(token) {
  const url = holdersCsvUrl(token);
  console.log("blockscout download", apiKey() ? "pro-api" : "instance", url.replace(apiKey(), "proapi_***"));
  const text = await fetchText(url);
  const out = writeCache(token, text);
  const holders = parseHoldersCsv(text);
  console.log("blockscout cached", { path: out, holders: holders.length });
  return { path: out, holders, text };
}

/** Paginated JSON holder list from Blockscout v2 API. */
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

/**
 * Called at the start of each keeper/cron run.
 * Tries Blockscout PRO API (with BLOCKSCOUT_API_KEY), then stale cache.
 */
export async function prepareHolderSnapshot(token) {
  const manual = String(process.env.HOLDERS_CSV_PATH || "").trim();
  if (manual) {
    console.log("holders: using manual HOLDERS_CSV_PATH", manual);
    return storePrepared(token, { source: "manual", path: manual, holders: loadHoldersCsv(manual) });
  }

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
    console.log("holders: using stale cache", out, "count", holders.length);
    return storePrepared(token, { source: "stale-cache", path: out, holders });
  }

  if (requireBlockscout()) {
    throw new Error("could not fetch Blockscout holders and no cache exists");
  }

  preparedSnapshot = null;
  return { source: "none", path: null, holders: null };
}

function storePrepared(token, result) {
  if (result.holders?.length) {
    preparedSnapshot = {
      token: getAddress(token),
      holders: result.holders,
      source: result.source,
      path: result.path,
    };
  }
  return result;
}

/** Load holders for merkle build (uses in-memory + file cache from prepareHolderSnapshot). */
export async function snapshotHoldersFromBlockscout(token) {
  const mem = getPreparedHolders(token);
  if (mem) return mem;

  const manual = String(process.env.HOLDERS_CSV_PATH || "").trim();
  if (manual) return loadHoldersCsv(manual);

  const out = cachePath(token);
  if (fs.existsSync(out)) return loadHoldersCsv(out);

  throw new Error("no holder data — call prepareHolderSnapshot first");
}
