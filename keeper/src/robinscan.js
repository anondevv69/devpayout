import fs from "node:fs";
import path from "node:path";
import { getAddress } from "viem";

const DEFAULT_BASE = "https://robinscan.io";

function baseUrl() {
  return String(process.env.ROBINSCAN_URL || DEFAULT_BASE).replace(/\/$/, "");
}

function cachePath(token) {
  const custom = String(process.env.HOLDERS_CACHE_PATH || "").trim();
  if (custom) return custom;
  const dir = String(process.env.HOLDERS_CACHE_DIR || ".cache").trim();
  return path.join(dir, `holders-robinscan-${getAddress(token).toLowerCase()}.json`);
}

function writeCache(token, holders) {
  const out = cachePath(token);
  try {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify({ holders, fetchedAt: new Date().toISOString() }, null, 0));
    return out;
  } catch (e) {
    console.log("robinscan cache write failed:", String(e?.message || e));
    return null;
  }
}

function loadCache(token) {
  const out = cachePath(token);
  if (!fs.existsSync(out)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(out, "utf8"));
    if (!data?.holders?.length) return null;
    return { path: out, holders: data.holders };
  } catch {
    return null;
  }
}

/** Paginated holder list from Robinscan partner API. */
export async function fetchHoldersFromRobinscan(token) {
  const addr = getAddress(token).toLowerCase();
  const holders = [];
  let page = 1;
  let total = null;

  while (true) {
    const url = `${baseUrl()}/api/tokens/${addr}/holders?page=${page}`;
    console.log("robinscan page", page, total != null ? `/ ${Math.ceil(total / 25)}` : "");
    const res = await fetch(url, {
      headers: { accept: "application/json", "user-agent": "devpayout-keeper/1.0" },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`robinscan ${res.status} ${body.slice(0, 120)}`);
    }
    const data = await res.json();
    if (data.status && data.status !== "ok") {
      throw new Error(`robinscan status ${data.status}`);
    }
    const items = data.items || [];
    if (total == null) total = Number(data.total || 0);
    for (const item of items) {
      const who = getAddress(item.holder || item.address);
      const amt = BigInt(item.balance || item.value || "0");
      if (amt > 0n) holders.push({ who, amt });
    }
    if (!items.length) break;
    if (holders.length >= total) break;
    page++;
    if (page > 200) throw new Error("robinscan pagination exceeded 200 pages");
  }

  holders.sort((a, b) => (a.who < b.who ? -1 : a.who > b.who ? 1 : 0));
  return holders;
}

export function requireRobinscan() {
  if (process.env.REQUIRE_ROBINSCAN === "0" || process.env.REQUIRE_ROBINSCAN === "false") return false;
  if (process.env.REQUIRE_ROBINSCAN === "1") return true;
  const source = String(process.env.HOLDERS_SOURCE || "robinscan").toLowerCase();
  return source === "robinscan";
}

/** Fresh Robinscan snapshot; caches JSON locally for Railway volume. */
export async function downloadHoldersRobinscan(token) {
  const holders = await fetchHoldersFromRobinscan(token);
  const p = writeCache(token, holders.map((h) => ({ who: h.who, amt: h.amt.toString() })));
  const parsed = holders;
  console.log("robinscan cached", { path: p, holders: parsed.length });
  return { path: p, holders: parsed };
}

export function loadHoldersRobinscanCache(token) {
  const cached = loadCache(token);
  if (!cached) return null;
  return {
    path: cached.path,
    holders: cached.holders.map((h) => ({ who: getAddress(h.who), amt: BigInt(h.amt) })),
  };
}
