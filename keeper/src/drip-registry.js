import fs from "node:fs";
import path from "node:path";
import { getAddress } from "viem";

function registryPath() {
  return String(process.env.DRIP_REGISTRY_PATH || "/data/drips.json").trim();
}

function emptyRegistry() {
  return { version: 1, updatedAt: null, drips: [] };
}

export function loadRegistry() {
  const file = registryPath();
  if (!fs.existsSync(file)) return emptyRegistry();
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!Array.isArray(data.drips)) return emptyRegistry();
    return data;
  } catch (e) {
    console.log("drip registry read failed:", String(e?.message || e));
    return emptyRegistry();
  }
}

export function saveRegistry(registry) {
  const file = registryPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  registry.updatedAt = new Date().toISOString();
  fs.writeFileSync(file, JSON.stringify(registry, null, 2));
  return file;
}

export function listDrips({ automatedOnly = false } = {}) {
  const { drips } = loadRegistry();
  return drips.filter((d) => (automatedOnly ? d.automated === true : true));
}

export function getDrip(idOrToken) {
  const key = String(idOrToken || "").trim().toLowerCase();
  const { drips } = loadRegistry();
  return (
    drips.find((d) => d.id === key) ||
    drips.find((d) => d.memeToken?.toLowerCase() === key) ||
    null
  );
}

export function upsertDrip(partial) {
  const registry = loadRegistry();
  const memeToken = getAddress(partial.memeToken);
  const id = partial.id || `drip-${memeToken.slice(2, 10)}`;
  const idx = registry.drips.findIndex(
    (d) => d.id === id || d.memeToken?.toLowerCase() === memeToken.toLowerCase(),
  );
  const row = {
    id,
    memeToken,
    pairedToken: getAddress(partial.pairedToken),
    router: getAddress(partial.router),
    distributor: getAddress(partial.distributor),
    symbol: partial.symbol || null,
    pairedSymbol: partial.pairedSymbol || null,
    automated: Boolean(partial.automated),
    platformFeeBps: Number(partial.platformFeeBps ?? process.env.PLATFORM_FEE_BPS ?? 1000),
    createdAt: partial.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    poolId: partial.poolId || null,
    notes: partial.notes || null,
  };
  if (idx >= 0) {
    registry.drips[idx] = { ...registry.drips[idx], ...row, createdAt: registry.drips[idx].createdAt };
  } else {
    registry.drips.push(row);
  }
  saveRegistry(registry);
  return getDrip(id);
}

export function setAutomated(idOrToken, automated = true) {
  const drip = getDrip(idOrToken);
  if (!drip) throw new Error("drip_not_found");
  return upsertDrip({ ...drip, automated: Boolean(automated) });
}
