import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { getAddress } from "viem";
import { createDripOnchain, factoryAddress } from "./factory.js";
import {
  DRIP_SOURCES,
  getDrip,
  listDrips,
  loadRegistry,
  normalizeSource,
  setAutomated,
  upsertDrip,
} from "../keeper/src/drip-registry.js";

const PORT = Number.parseInt(process.env.PORT || "8080", 10);
const PLATFORM_FEE_BPS = Number(process.env.PLATFORM_FEE_BPS || "1000");
const TREASURY = (process.env.TREASURY || "0x374d91a5674fa7cf86e725093b5848b97e1e13b4").toLowerCase();
const CRON = process.env.DRIP_CRON || "*/30 * * * *";
const BANKR_TRANSFER = "https://api.bankr.bot/public/doppler/build-transfer-beneficiary";

function json(res, status, body) {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "content-type",
    "access-control-allow-methods": "GET,POST,OPTIONS",
  });
  res.end(payload);
}

async function readJson(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function sources() {
  return {
    bankr: {
      id: "bankr",
      label: "Bankr / Doppler",
      sites: ["https://bankr.bot"],
      feeModel: "Doppler fee beneficiary (≥95%) — retarget to drip router",
      discover: "GET https://api.bankr.bot/public/doppler/beneficiary-fees/{wallet}",
      automate: "bankr_retarget",
    },
    pools_fun: {
      id: "pools_fun",
      label: "pools.fun (Sushi × Bankr)",
      sites: ["https://pools.fun", "https://bankr.bot"],
      feeModel:
        "Sushi V3 creator fee share. Prefer Fee Recipient = drip router at launch; " +
        "else claim/distribute and forward paired RWA to distributor (or to router then route).",
      discover: "User provides meme + stock quote addresses from pools.fun / Bankr",
      automate: "launch_recipient_or_forward",
    },
    pools_trade: {
      id: "pools_trade",
      label: "pools.trade (Uniswap Labs)",
      sites: ["https://pools.trade"],
      feeModel:
        "Optional creator fee (~0.05% of 0.25% LP fee). Set creator fee wallet to drip router. " +
        "Stock-paired only — WETH-only launches are ineligible.",
      discover: "User provides meme + stock quote from pools.trade",
      automate: "set_creator_fee_wallet",
    },
  };
}

function platform() {
  return {
    product: "devpayout-drip",
    phase: "B",
    platformFeeBps: PLATFORM_FEE_BPS,
    platformFeePercent: PLATFORM_FEE_BPS / 100,
    treasury: TREASURY,
    cron: CRON,
    onePerRwa: false,
    flow: ["create", "test_send_paired_to_distributor", "test_drip", "automate_retarget"],
    factory: factoryAddress(),
    canAutoDeploy: Boolean(factoryAddress()),
    sources: sources(),
    supportedSources: DRIP_SOURCES,
  };
}

function automateNote(source) {
  if (source === "pools_fun") {
    return "At launch set Fee Recipient to the drip router, or forward claimed creator fees to the distributor";
  }
  if (source === "pools_trade") {
    return "Set pools.trade creator fee wallet to the drip router (stock-paired tokens only)";
  }
  return "When ready, POST /v1/drips/:id/automate and sign the Bankr Doppler retarget tx";
}

function dripResponse(drip) {
  const source = normalizeSource(drip.source);
  return {
    ...drip,
    source,
    testInstructions: {
      sendPairedTokenTo: drip.distributor,
      pairedToken: drip.pairedToken,
      note: "Send a small amount of the paired RWA to the distributor, then POST /v1/drips/:id/test",
    },
    automateInstructions: {
      retargetFeeBeneficiaryTo: drip.router,
      source,
      note: automateNote(source),
    },
  };
}

async function buildRetarget({ tokenAddress, currentBeneficiary, newBeneficiary }) {
  const res = await fetch(BANKR_TRANSFER, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tokenAddress, currentBeneficiary, newBeneficiary }),
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text };
  }
  if (!res.ok) {
    const err = new Error(`bankr_retarget_${res.status}`);
    err.body = body;
    throw err;
  }
  return body;
}

function poolsFunAutomate(drip) {
  return {
    mode: "launch_recipient_or_forward",
    source: "pools_fun",
    router: drip.router,
    distributor: drip.distributor,
    steps: [
      {
        preferred: true,
        title: "Best: Fee Recipient at launch",
        detail:
          "On pools.fun / Bankr launch, set Fee Recipient to the drip router before deploy so creator fees land on the router.",
        feeRecipient: drip.router,
      },
      {
        title: "Existing token: forward fees",
        detail:
          "Claim / Distribute trading fees to the creator wallet, then send the paired RWA leg to the distributor (test) or to the router (then keeper route()).",
        sendPairedToDistributor: drip.distributor,
        sendPairedToRouter: drip.router,
      },
    ],
    message:
      "pools.fun creator address is often fixed at launch — prefer Fee Recipient = router on create. " +
      "Mark automated after you confirm fees will reach the router or you will forward paired RWA.",
  };
}

function poolsTradeAutomate(drip) {
  return {
    mode: "set_creator_fee_wallet",
    source: "pools_trade",
    router: drip.router,
    distributor: drip.distributor,
    steps: [
      {
        title: "Enable creator fee (if not already)",
        detail: "pools.trade optional creator fee is ~0.05% of the 0.25% LP fee.",
      },
      {
        title: "Set creator fee wallet → drip router",
        detail: "In pools.trade token settings, change the creator fee recipient to the drip router.",
        feeRecipient: drip.router,
        url: "https://pools.trade",
      },
    ],
    message:
      "After the creator fee wallet is the drip router, the shared 30m keeper will route() balances and pay holders. " +
      "Stock-paired only — skip WETH-only launches.",
  };
}

async function handle(req, res) {
  if (req.method === "OPTIONS") {
    return json(res, 204, {});
  }

  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const path = url.pathname.replace(/\/+$/, "") || "/";

  if (req.method === "GET" && (path === "/" || path === "/health")) {
    return json(res, 200, { ok: true, service: "devpayout-api", ...platform() });
  }

  if (req.method === "GET" && path === "/v1/platform") {
    return json(res, 200, platform());
  }

  if (req.method === "GET" && path === "/v1/drips") {
    return json(res, 200, { items: listDrips().map(dripResponse), registry: loadRegistry().updatedAt });
  }

  if (req.method === "GET" && path.startsWith("/v1/drips/") && !path.includes("/test") && !path.includes("/automate")) {
    const id = decodeURIComponent(path.slice("/v1/drips/".length));
    const drip = getDrip(id);
    if (!drip) return json(res, 404, { error: "drip_not_found" });
    return json(res, 200, dripResponse(drip));
  }

  if (req.method === "POST" && path === "/v1/drips") {
    const body = await readJson(req);
    try {
      const memeToken = getAddress(body.memeToken || body.tokenAddress);
      const pairedToken = getAddress(body.pairedToken);
      const source = normalizeSource(body.source || body.launchpad || body.platform);
      let router = body.router ? getAddress(body.router) : null;
      let distributor = body.distributor ? getAddress(body.distributor) : null;
      let deployTx = null;

      const existing = getDrip(memeToken);
      if (existing?.router && existing?.distributor && !body.forceNew) {
        return json(res, 200, {
          drip: dripResponse(existing),
          reused: true,
          next: [
            `Send paired RWA (${existing.pairedSymbol || existing.pairedToken}) to ${existing.distributor}`,
            `POST /v1/drips/${existing.id}/test`,
            `When ready: POST /v1/drips/${existing.id}/automate`,
          ],
        });
      }

      if (!router || !distributor) {
        if (!factoryAddress()) {
          return json(res, 400, {
            error: "factory_not_configured",
            message:
              "Omit router/distributor only after DRIP_FACTORY is set on the API. " +
              "Until then pass router + distributor from a manual deploy.",
            platform: platform(),
          });
        }
        const created = await createDripOnchain({ memeToken, pairedToken });
        router = created.router;
        distributor = created.distributor;
        deployTx = {
          hash: created.txHash,
          factoryDripId: created.dripId,
          factory: created.factory,
        };
      }

      const drip = upsertDrip({
        memeToken,
        pairedToken,
        router,
        distributor,
        source,
        symbol: body.symbol || body.tokenSymbol || null,
        pairedSymbol: body.pairedSymbol || body.pairedStockSymbol || null,
        automated: false,
        platformFeeBps: PLATFORM_FEE_BPS,
        poolId: body.poolId || null,
        notes:
          body.notes ||
          (deployTx
            ? `deployed via DripFactory (${source}) — test before automate`
            : `registered via API (${source}) — test before automate`),
      });

      return json(res, 201, {
        drip: dripResponse(drip),
        deployed: deployTx,
        sourceInfo: sources()[source],
        next: [
          `Send paired RWA (${drip.pairedSymbol || drip.pairedToken}) to ${drip.distributor}`,
          `POST /v1/drips/${drip.id}/test`,
          `When ready: POST /v1/drips/${drip.id}/automate`,
        ],
      });
    } catch (e) {
      const msg = String(e?.shortMessage || e?.message || e);
      return json(res, 400, { error: msg, details: e?.body || undefined });
    }
  }

  if (req.method === "POST" && path.match(/^\/v1\/drips\/[^/]+\/test$/)) {
    const id = decodeURIComponent(path.split("/")[3]);
    const drip = getDrip(id);
    if (!drip) return json(res, 404, { error: "drip_not_found" });
    return json(res, 202, {
      accepted: true,
      drip: dripResponse(drip),
      message:
        "Test drip: ensure paired RWA is on the distributor, then run the keeper with " +
        `DRIP_ID=${drip.id} (or wait for cron if INCLUDE_MANUAL=1).`,
      run: {
        env: {
          DRIP_ID: drip.id,
          DRIP_SOURCE: normalizeSource(drip.source),
          DEV_MSFT_ROUTER: drip.router,
          MSFT_HOLDER_DISTRIBUTOR: drip.distributor,
          DEV_TOKEN: drip.memeToken,
          MSFT_TOKEN: drip.pairedToken,
        },
      },
    });
  }

  if (req.method === "POST" && path.match(/^\/v1\/drips\/[^/]+\/automate$/)) {
    const id = decodeURIComponent(path.split("/")[3]);
    const drip = getDrip(id);
    if (!drip) return json(res, 404, { error: "drip_not_found" });
    const body = await readJson(req);
    const source = normalizeSource(body.source || drip.source);

    if (source === "pools_fun") {
      const updated = upsertDrip({ ...drip, source, automated: true });
      return json(res, 200, {
        drip: dripResponse(updated),
        automate: poolsFunAutomate(updated),
        message: poolsFunAutomate(updated).message,
      });
    }

    if (source === "pools_trade") {
      const updated = upsertDrip({ ...drip, source, automated: true });
      return json(res, 200, {
        drip: dripResponse(updated),
        automate: poolsTradeAutomate(updated),
        message: poolsTradeAutomate(updated).message,
      });
    }

    const currentBeneficiary = body.currentBeneficiary;
    if (!currentBeneficiary) {
      return json(res, 400, {
        error: "currentBeneficiary_required",
        message: "Pass the wallet that currently holds ≥95% Doppler fee share (Bankr / Doppler tokens)",
        source: "bankr",
      });
    }
    try {
      const retarget = await buildRetarget({
        tokenAddress: drip.memeToken,
        currentBeneficiary: getAddress(currentBeneficiary),
        newBeneficiary: drip.router,
      });
      const updated = setAutomated(drip.id, true);
      return json(res, 200, {
        drip: dripResponse({ ...updated, source: "bankr" }),
        retarget,
        message: "Sign the retarget tx, then the shared 30m keeper will collect + drip automatically.",
      });
    } catch (e) {
      return json(res, 502, { error: String(e?.message || e), details: e?.body });
    }
  }

  return json(res, 404, { error: "not_found" });
}

export function startApi(port = PORT) {
  const server = createServer((req, res) => {
    handle(req, res).catch((e) => {
      console.error(e);
      json(res, 500, { error: String(e?.message || e) });
    });
  });
  server.listen(port, () => {
    console.log(JSON.stringify({ service: "devpayout-api", port, ...platform() }));
  });
  return server;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  startApi();
}
