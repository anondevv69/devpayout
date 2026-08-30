import fs from "node:fs";
import { getAddress } from "viem";

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

/** Parse holder CSV (HolderAddress,Balance) — Blockscout / Robinscan export format. */
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

export function holdersToCsv(holders) {
  const lines = ["HolderAddress,Balance"];
  for (const h of holders) {
    lines.push(`${getAddress(h.who)},${h.amt.toString()}`);
  }
  return `${lines.join("\n")}\n`;
}
