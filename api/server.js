import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { getAddress } from "viem";
import { getDrip, listDrips, loadRegistry, setAutomated, upsertDrip } from "../keeper/src/drip-registry.js";

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
    factory: process.env.DRIP_FACTORY || null,
  };
}

function dripResponse(drip) {
  return {
    ...drip,
    testInstructions: {
      sendPairedTokenTo: drip.distributor,
      pairedToken: drip.pairedToken,
      note: "Send a small amount of the paired RWA to the distributor, then POST /v1/drips/:id/test",
    },
    automateInstructions: {
      retargetFeeBeneficiaryTo: drip.router,
      note: "When ready, POST /v1/drips/:id/automate and sign the Bankr retarget tx",
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

  if (req.method === "GET" && path.startsWith("/v1/drips/")) {
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
      const router = body.router ? getAddress(body.router) : null;
      const distributor = body.distributor ? getAddress(body.distributor) : null;

      if (!router || !distributor) {
        return json(res, 400, {
          error: "router_and_distributor_required",
          message:
            "Pass router + distributor from a Forge/factory deploy. " +
            "Onchain factory deploy-from-API lands after DRIP_FACTORY is set and funded.",
          platform: platform(),
        });
      }

      const drip = upsertDrip({
        memeToken,
        pairedToken,
        router,
        distributor,
        symbol: body.symbol || body.tokenSymbol || null,
        pairedSymbol: body.pairedSymbol || body.pairedStockSymbol || null,
        automated: false,
        platformFeeBps: PLATFORM_FEE_BPS,
        poolId: body.poolId || null,
        notes: body.notes || "registered via API — test before automate",
      });

      return json(res, 201, {
        drip: dripResponse(drip),
        next: [
          `Send paired RWA (${drip.pairedSymbol || drip.pairedToken}) to ${drip.distributor}`,
          `POST /v1/drips/${drip.id}/test`,
          `When ready: POST /v1/drips/${drip.id}/automate with currentBeneficiary`,
        ],
      });
    } catch (e) {
      return json(res, 400, { error: String(e?.message || e) });
    }
  }

  if (req.method === "POST" && path.match(/^\/v1\/drips\/[^/]+\/test$/)) {
    const id = decodeURIComponent(path.split("/")[3]);
    const drip = getDrip(id);
    if (!drip) return json(res, 404, { error: "drip_not_found" });
    // Kick is async via env for the worker; API records intent.
    return json(res, 202, {
      accepted: true,
      drip: dripResponse(drip),
      message:
        "Test drip: ensure paired RWA is on the distributor, then run the keeper with " +
        `DRIP_ID=${drip.id} (or wait for cron if this drip is included with INCLUDE_MANUAL=1).`,
      run: {
        env: {
          DRIP_ID: drip.id,
          DRIP_MODE: "single",
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
    const currentBeneficiary = body.currentBeneficiary;
    if (!currentBeneficiary) {
      return json(res, 400, {
        error: "currentBeneficiary_required",
        message: "Pass the wallet that currently holds ≥95% Doppler fee share",
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
        drip: dripResponse(updated),
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
