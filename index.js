import express from "express";

const app = express();
app.use(express.json({ limit: "1mb" }));

app.get("/", (_, res) => res.status(200).send("OK"));

function checkKey(req, res) {
  const expected = process.env.WEBHOOK_KEY;
  if (!expected) return true;
  const key = req.query.key;
  if (key !== expected) {
    res.status(401).send("Unauthorized");
    return false;
  }
  return true;
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

  try {
    return JSON.parse(text);
  } catch {
    throw new Error("BasitKargo response is not JSON");
  }
}

// Basit Kargo response’undan Shopify Order GID üret
function extractShopifyOrderGidFromBasitKargo(bk) {
  // Senin örnekte: content.code = "7708726460709" (Shopify Order ID)
  const raw = bk?.content?.code || bk?.foreignCode || null;
  if (!raw) return null;

  const s = raw.toString().trim();
  if (/^\d{10,16}$/.test(s)) return `gid://shopify/Order/${s}`;
  return null;
}

function normalizeCarrierName(bk, payload) {
  return (
    bk?.shipmentInfo?.handler?.name ||
    payload?.shipmentInfo?.handler?.name ||
    payload?.handler?.name ||
    bk?.shipmentInfo?.handler?.code ||
    payload?.shipmentInfo?.handler?.code ||
    payload?.handler?.code ||
    "Other"
  );
}

function normalizeTrackingNumber(bk, payload) {
  return (
    bk?.shipmentInfo?.handlerShipmentCode ||
    payload?.shipmentInfo?.handlerShipmentCode ||
    payload?.handlerShipmentCode ||
    payload?.barcode ||
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

async function fulfillWithTrackingOnOpenFOs(orderGid, carrierName, trackingNumber) {
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
        fulfillment {
          id
          status
          trackingInfo { company number url }
        }
        userErrors { field message }
      }
    }
  `;

  const results = [];
  for (const fo of openFOs) {
    const vars = {
      fulfillment: {
        notifyCustomer: true,
        trackingInfo: {
          company: carrierName,
          number: trackingNumber,
        },
        lineItemsByFulfillmentOrder: [{ fulfillmentOrderId: fo.id }],
      },
    };

    const resp = await shopifyGraphql(fulfillMutation, vars);
    const userErrors = resp?.data?.fulfillmentCreateV2?.userErrors || [];
    if (userErrors.length) {
      return { ok: false, msg: `Shopify userErrors: ${JSON.stringify(userErrors)}` };
    }
    const f = resp?.data?.fulfillmentCreateV2?.fulfillment;
    results.push({ fo: fo.id, fulfillmentId: f?.id, status: f?.status });
  }

  return {
    ok: true,
    msg: `OK: ${order.name} tracking=${trackingNumber} fulfillments=${results.map((x) => x.fulfillmentId).join(",")}`,
  };
}

/* -------------------- Webhook Handler -------------------- */

async function handleBasitKargoWebhook(payload) {
  // Basit Kargo tarafında statüler: READY_TO_SHIP, SHIPPED vb
  const okStatuses = new Set(["READY_TO_SHIP", "SHIPPED"]);
  if (!okStatuses.has(payload?.status)) return { ok: true, msg: "Ignored" };

  if (!payload?.id) return { ok: false, msg: "Webhook payload missing id" };

  // Basit Kargo order detail çek
  const bk = await basitKargoGetOrderById(payload.id);

  const orderGid = extractShopifyOrderGidFromBasitKargo(bk);
  if (!orderGid) return { ok: false, msg: "BasitKargo response içinde Shopify Order ID yok (content.code/foreignCode)" };

  const trackingNumber = normalizeTrackingNumber(bk, payload);
  if (!trackingNumber) return { ok: false, msg: "Tracking number not found (handlerShipmentCode/barcode)" };

  const carrierName = normalizeCarrierName(bk, payload);

  // Shopify fulfillment + tracking
  return await fulfillWithTrackingOnOpenFOs(orderGid, carrierName, trackingNumber);
}

/* -------------------- Routes -------------------- */

// Gerçek Basit Kargo webhook endpoint
app.post("/basitkargo-webhook", async (req, res) => {
  if (!checkKey(req, res)) return;

  try {
    // Debug gerekirse aç:
    // console.log("BASITKARGO WEBHOOK:", JSON.stringify(req.body));

    const result = await handleBasitKargoWebhook(req.body);
    return res.status(result.ok ? 200 : 400).send(result.msg);
  } catch (e) {
    console.error(e);
    return res.status(500).send(e?.message || "Server error");
  }
});

// Manuel test: sadece Basit Kargo order id ver
app.post("/manual-bk", async (req, res) => {
  if (!checkKey(req, res)) return;

  try {
    // body: { id: "LTU-22S-9GV", status:"READY_TO_SHIP" }
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

const port = process.env.PORT || 3000;
app.listen(port, () => console.log("Listening on", port));
