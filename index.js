import express from "express";

const app = express();
app.use(express.json({ limit: "2mb" }));

/* -------------------- Basics -------------------- */

app.get("/", (_, res) => res.status(200).send("OK"));

function checkKey(req, res) {
  const expected = process.env.WEBHOOK_KEY;
  if (!expected) return true; // if you want it mandatory, remove this line and enforce key always
  const key = req.query.key;
  if (key !== expected) {
    res.status(401).send("Unauthorized");
    return false;
  }
  return true;
}

/* -------------------- Time helpers (Europe/Istanbul) -------------------- */

function istanbulDayISO(date = new Date()) {
  // returns YYYY-MM-DD in Europe/Istanbul
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Istanbul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);

  const y = parts.find((p) => p.type === "year")?.value;
  const m = parts.find((p) => p.type === "month")?.value;
  const d = parts.find((p) => p.type === "day")?.value;
  return `${y}-${m}-${d}`;
}

function istanbulTodayRange() {
  const day = istanbulDayISO(new Date());
  // BasitKargo expects local-looking timestamps; TR is fixed UTC+3 generally.
  // We'll send as "YYYY-MM-DDT00:00:00" and next day "YYYY-MM-DDT00:00:00"
  const startDate = `${day}T00:00:00`;

  // next day
  const dt = new Date(`${day}T00:00:00+03:00`);
  dt.setDate(dt.getDate() + 1);
  const nextDay = istanbulDayISO(dt);
  const endDate = `${nextDay}T00:00:00`;

  return { startDate, endDate };
}

/* -------------------- Basit Kargo -------------------- */

async function basitKargoGetOrderById(id) {
  const token = process.env.BASITKARGO_TOKEN;
  if (!token) throw new Error("Missing BASITKARGO_TOKEN");

  const url = `https://basitkargo.com/api/v2/order/${encodeURIComponent(id)}`;
  const r = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
  });

  const text = await r.text();
  if (!r.ok) throw new Error(`BasitKargo HTTP ${r.status}: ${text}`);
  return JSON.parse(text);
}

async function basitKargoFilterOrders({ startDate, endDate, statusList, page = 0, size = 100 }) {
  const token = process.env.BASITKARGO_TOKEN;
  if (!token) throw new Error("Missing BASITKARGO_TOKEN");

  const url = "https://basitkargo.com/api/v2/order/filter";
  const r = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ startDate, endDate, statusList, page, size }),
  });

  const text = await r.text();
  if (!r.ok) throw new Error(`BasitKargo HTTP ${r.status}: ${text}`);
  return JSON.parse(text);
}

function extractShopifyOrderGidFromBasitKargo(bk) {
  // In your real example: content.code / foreignCode = "7708726460709" (Shopify Order numeric ID)
  const raw = bk?.content?.code || bk?.foreignCode || null;
  if (!raw) return null;

  const s = raw.toString().trim();
  if (/^\d{10,16}$/.test(s)) return `gid://shopify/Order/${s}`;
  return null;
}

function normalizeTrackingNumber(bk, payload) {
  return (
    bk?.shipmentInfo?.handlerShipmentCode ||
    payload?.shipmentInfo?.handlerShipmentCode ||
    payload?.handlerShipmentCode ||
    bk?.barcode ||
    payload?.barcode ||
    null
  );
}

function normalizeTrackingUrl(bk, payload) {
  return (
    bk?.shipmentInfo?.handlerShipmentTrackingLink ||
    payload?.shipmentInfo?.handlerShipmentTrackingLink ||
    null
  );
}

/* -------------------- Shopify GraphQL -------------------- */

async function shopifyGraphql(query, variables) {
  const store = process.env.SHOPIFY_STORE;
  const token = process.env.SHOPIFY_TOKEN;
  if (!store || !token) throw new Error("Missing SHOPIFY_STORE or SHOPIFY_TOKEN");

  const url = `https://${store}/admin/api/2024-10/graphql.json`;
  const r = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": token,
    },
    body: JSON.stringify({ query, variables }),
  });

  const text = await r.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`Shopify non-JSON response HTTP ${r.status}: ${text}`);
  }

  if (!r.ok) throw new Error(`Shopify HTTP ${r.status}: ${text}`);
  if (json.errors?.length) throw new Error(`Shopify GraphQL errors: ${JSON.stringify(json.errors)}`);

  return json;
}

async function fulfillWithTrackingOnOpenFOs(orderGid, trackingNumber, trackingUrl) {
  const getOrderQuery = `
    query ($id: ID!) {
      order(id: $id) {
        id
        name
        fulfillmentOrders(first: 20) {
          edges { node { id status } }
        }
      }
    }
  `;

  const got = await shopifyGraphql(getOrderQuery, { id: orderGid });
  const order = got?.data?.order;
  if (!order) return { ok: false, msg: `Order not found by id: ${orderGid}` };

  const foNodes = (order.fulfillmentOrders?.edges || []).map((e) => e.node);
  const openFOs = foNodes.filter((n) => n.status === "OPEN" || n.status === "IN_PROGRESS");

  if (!openFOs.length) {
    return { ok: true, msg: `No OPEN/IN_PROGRESS fulfillmentOrder for ${order.name} (already fulfilled/closed)` };
  }

  const fulfillMutation = `
    mutation ($fulfillment: FulfillmentV2Input!) {
      fulfillmentCreateV2(fulfillment: $fulfillment) {
        fulfillment { id status trackingInfo { company number url } }
        userErrors { field message }
      }
    }
  `;

  const results = [];
  for (const fo of openFOs) {
    const trackingInfo = {
      company: "Other", // ✅ always Other (as you requested)
      number: trackingNumber,
      ...(trackingUrl ? { url: trackingUrl } : {}),
    };

    const vars = {
      fulfillment: {
        notifyCustomer: true,
        trackingInfo,
        lineItemsByFulfillmentOrder: [{ fulfillmentOrderId: fo.id }],
      },
    };

    const resp = await shopifyGraphql(fulfillMutation, vars);
    const userErrors = resp?.data?.fulfillmentCreateV2?.userErrors || [];
    if (userErrors.length) return { ok: false, msg: `Shopify userErrors: ${JSON.stringify(userErrors)}` };

    const f = resp?.data?.fulfillmentCreateV2?.fulfillment;
    results.push({ fo: fo.id, fulfillmentId: f?.id, status: f?.status });
  }

  return {
    ok: true,
    msg: `OK: ${order.name} tracking=${trackingNumber} fulfillments=${results.map((x) => x.fulfillmentId).join(",")}`,
  };
}

/* -------------------- Core handler -------------------- */

async function handleBasitKargoWebhook(payload) {
  // Panel "webhook test" often sends dummy/no body → do not fail
  if (!payload || !payload.id) return { ok: true, msg: "OK (test payload ignored)" };

  // Work on these statuses (safe):
  const okStatuses = new Set(["READY_TO_SHIP", "SHIPPED"]);
  if (payload.status && !okStatuses.has(payload.status)) return { ok: true, msg: "OK (status ignored)" };

  const bk = await basitKargoGetOrderById(payload.id);

  const orderGid = extractShopifyOrderGidFromBasitKargo(bk);
  if (!orderGid) return { ok: false, msg: "BasitKargo response missing Shopify order id (content.code/foreignCode)" };

  const trackingNumber = normalizeTrackingNumber(bk, payload);
  if (!trackingNumber) return { ok: false, msg: "Tracking number missing (handlerShipmentCode/barcode)" };

  const trackingUrl = normalizeTrackingUrl(bk, payload);

  return await fulfillWithTrackingOnOpenFOs(orderGid, trackingNumber, trackingUrl);
}

/* -------------------- Routes -------------------- */

// Real BasitKargo webhook endpoint
app.post("/basitkargo-webhook", async (req, res) => {
  if (!checkKey(req, res)) return;

  try {
    const result = await handleBasitKargoWebhook(req.body);
    return res.status(result.ok ? 200 : 400).send(result.msg);
  } catch (e) {
    console.error(e);
    return res.status(500).send(e?.message || "Server error");
  }
});

// Manual single-order test (give BasitKargo order id)
app.post("/manual-bk", async (req, res) => {
  if (!checkKey(req, res)) return;

  try {
    const payload = {
      id: req.body?.id,
      status: req.body?.status || "READY_TO_SHIP",
    };
    const result = await handleBasitKargoWebhook(payload);
    return res.status(result.ok ? 200 : 400).send(result.msg);
  } catch (e) {
    console.error(e);
    return res.status(500).send(e?.message || "Server error");
  }
});

// Backfill: fulfill today's shipments in bulk (READY_TO_SHIP + SHIPPED)
// You can override date range via body: { startDate:"YYYY-MM-DDT00:00:00", endDate:"YYYY-MM-DDT00:00:00", statusList:[...] }
app.post("/backfill-today", async (req, res) => {
  if (!checkKey(req, res)) return;

  try {
    const { startDate: defStart, endDate: defEnd } = istanbulTodayRange();
    const startDate = req.body?.startDate || defStart;
    const endDate = req.body?.endDate || defEnd;
    const statusList = req.body?.statusList || ["READY_TO_SHIP", "SHIPPED"];

    const size = Number(req.body?.size || 100);
    const maxPages = Number(req.body?.maxPages || 50);

    const done = [];
    const failed = [];

    for (let page = 0; page < maxPages; page++) {
      const resp = await basitKargoFilterOrders({ startDate, endDate, statusList, page, size });

      // BasitKargo may return list under different keys; try common ones:
      const items =
        resp?.content ||
        resp?.items ||
        resp?.data ||
        resp?.orders ||
        resp?.result ||
        [];

      if (!Array.isArray(items) || items.length === 0) break;

      for (const it of items) {
        const id = it?.id;
        if (!id) continue;

        try {
          const r = await handleBasitKargoWebhook({ id, status: "READY_TO_SHIP" });
          if (r?.ok) done.push({ id, msg: r.msg });
          else failed.push({ id, msg: r.msg });
        } catch (e) {
          failed.push({ id, msg: e?.message || "error" });
        }
      }

      if (items.length < size) break;
    }

    return res.json({
      ok: true,
      startDate,
      endDate,
      statusList,
      doneCount: done.length,
      failedCount: failed.length,
      failed,
    });
  } catch (e) {
    console.error(e);
    return res.status(500).send(e?.message || "Server error");
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log("Listening on", port));
