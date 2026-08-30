import fs from "node:fs";
import path from "node:path";
import { getAddress } from "viem";
import { loadHoldersCsv } from "./holders-csv.js";
import {
  downloadHoldersRobinscan,
  loadHoldersRobinscanCache,
  requireRobinscan,
} from "./robinscan.js";

/** In-memory holders from the latest prepareHolderSnapshot() call this process. */
let preparedSnapshot = null;

export function holderSource() {
  return String(process.env.HOLDERS_SOURCE || "robinscan").toLowerCase();
}

function defaultCachePath(token) {
  const custom = String(process.env.HOLDERS_CACHE_PATH || "").trim();
  if (custom) return custom;
  const dir = String(process.env.HOLDERS_CACHE_DIR || ".cache").trim();
  return path.join(dir, `holders-${getAddress(token).toLowerCase()}.csv`);
}

export function getPreparedHolders(token) {
  const addr = getAddress(token);
  if (preparedSnapshot?.token === addr && preparedSnapshot.holders?.length) {
    return preparedSnapshot.holders;
  }
  return null;
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

async function prepareRobinscanSnapshot(token) {
  try {
    const { path: p, holders } = await downloadHoldersRobinscan(token);
    return storePrepared(token, { source: "robinscan-csv", path: p, holders });
  } catch (e) {
    console.log("robinscan fetch failed:", String(e?.message || e));
  }

  const cached = loadHoldersRobinscanCache(token);
  if (cached) {
    console.log("holders: using stale robinscan cache", cached.path, "count", cached.holders.length);
    return storePrepared(token, { source: "robinscan-stale-cache", path: cached.path, holders: cached.holders });
  }

  const fallback = defaultCachePath(token);
  if (fs.existsSync(fallback)) {
    const holders = loadHoldersCsv(fallback);
    console.log("holders: using stale csv cache", fallback, "count", holders.length);
    return storePrepared(token, { source: "stale-csv-cache", path: fallback, holders });
  }

  if (requireRobinscan()) {
    throw new Error("could not fetch Robinscan holders and no cache exists");
  }

  preparedSnapshot = null;
  return { source: "none", path: null, holders: null };
}

/**
 * Fresh holder snapshot at the start of each keeper/cron run.
 * Default: Robinscan API → cached CSV on disk.
 */
export async function prepareHolderSnapshot(token) {
  const manual = String(process.env.HOLDERS_CSV_PATH || "").trim();
  if (manual) {
    console.log("holders: using manual HOLDERS_CSV_PATH", manual);
    return storePrepared(token, { source: "manual", path: manual, holders: loadHoldersCsv(manual) });
  }

  const source = holderSource();
  if (source === "robinscan") {
    return prepareRobinscanSnapshot(token);
  }

  if (source === "blockscout") {
    const { prepareBlockscoutSnapshot } = await import("./blockscout.js");
    return prepareBlockscoutSnapshot(token, { storePrepared });
  }

  preparedSnapshot = null;
  return { source: "none", path: null, holders: null };
}

/** Load holders for merkle build (in-memory cache from prepareHolderSnapshot). */
export async function snapshotHoldersFromPrepared(token) {
  const mem = getPreparedHolders(token);
  if (mem) return mem;

  const manual = String(process.env.HOLDERS_CSV_PATH || "").trim();
  if (manual) return loadHoldersCsv(manual);

  const cached = loadHoldersRobinscanCache(token);
  if (cached) return cached.holders;

  const fallback = defaultCachePath(token);
  if (fs.existsSync(fallback)) return loadHoldersCsv(fallback);

  throw new Error("no holder data — call prepareHolderSnapshot first");
}
