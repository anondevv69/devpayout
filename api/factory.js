import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  getAddress,
  http,
  parseAbiItem,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

const __dirname = dirname(fileURLToPath(import.meta.url));

const robinhood = {
  id: 4663,
  name: "Robinhood Chain",
  nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.mainnet.chain.robinhood.com"] } },
};

const dripCreatedEvent = parseAbiItem(
  "event DripCreated(uint256 indexed dripId, address indexed memeToken, address indexed pairedToken, address router, address distributor, address creator)",
);

function loadFactoryArtifact() {
  const candidates = [
    join(__dirname, "../artifacts/DripFactory.json"),
    join(__dirname, "../out/DripFactory.sol/DripFactory.json"),
  ];
  for (const path of candidates) {
    try {
      return JSON.parse(readFileSync(path, "utf8"));
    } catch {
      // try next
    }
  }
  throw new Error("DripFactory artifact missing — run forge build and ensure artifacts/DripFactory.json is in the image");
}

function rpcUrl() {
  return String(process.env.ROBINHOOD_RPC_URL || "https://rpc.mainnet.chain.robinhood.com").trim();
}

function callerKey() {
  const raw = String(
    process.env.FACTORY_CALLER_KEY || process.env.DEPLOYER_KEY || process.env.KEEPER_KEY || "",
  ).trim();
  if (!raw) throw new Error("factory_caller_key_required");
  return raw.startsWith("0x") ? raw : `0x${raw}`;
}

/** Robinhood mainnet DripFactory (DeployDripFactory.s.sol). Override with DRIP_FACTORY. */
const DEFAULT_DRIP_FACTORY = "0x5B5ade0E3b38842f1758DE629F0Cd35AF647fC28";

export function factoryAddress() {
  const raw = String(process.env.DRIP_FACTORY || DEFAULT_DRIP_FACTORY || "").trim();
  return raw ? getAddress(raw) : null;
}

function clients() {
  const account = privateKeyToAccount(callerKey());
  const transport = http(rpcUrl());
  const publicClient = createPublicClient({ chain: robinhood, transport });
  const wallet = createWalletClient({ account, chain: robinhood, transport });
  return { account, publicClient, wallet };
}

export async function createDripOnchain({ memeToken, pairedToken }) {
  const factory = factoryAddress();
  if (!factory) throw new Error("DRIP_FACTORY_not_configured");

  const artifact = loadFactoryArtifact();
  const { account, publicClient, wallet } = clients();
  const meme = getAddress(memeToken);
  const paired = getAddress(pairedToken);

  const hash = await wallet.writeContract({
    address: factory,
    abi: artifact.abi,
    functionName: "createDrip",
    args: [meme, paired],
    account,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`createDrip_failed:${hash}`);

  for (const log of receipt.logs) {
    try {
      const decoded = decodeEventLog({
        abi: [dripCreatedEvent],
        data: log.data,
        topics: log.topics,
      });
      if (decoded.eventName === "DripCreated") {
        return {
          dripId: decoded.args.dripId.toString(),
          memeToken: getAddress(decoded.args.memeToken),
          pairedToken: getAddress(decoded.args.pairedToken),
          router: getAddress(decoded.args.router),
          distributor: getAddress(decoded.args.distributor),
          creator: getAddress(decoded.args.creator),
          txHash: hash,
          factory,
        };
      }
    } catch {
      // not our event
    }
  }
  throw new Error(`createDrip_no_event:${hash}`);
}
