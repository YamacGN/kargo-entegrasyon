import express from "express";

const app = express();
app.use(express.json({ limit: "1mb" }));

app.get("/", (_, res) => res.status(200).send("OK"));
console.log("STORE:", process.env.SHOPIFY_STORE);

function checkKey(req, res) {
  const expected = process.env.WEBHOOK_KEY;
  if (!expected) return true; // istersen key zorunlu yap
  const key = req.query.key;
  if (key !== expected) {
    res.status(401).send("Unauthorized");
    return false;
  }
  return true;
}

function buildOrderQuery(orderInput) {
  // orderInput: "1009" | "LP-1009" | "#LP-1009" | "#1009"
  const raw = (orderInput ?? "").toString().trim();
  if (!raw) return null;

  const withHash = raw.startsWith("#") ? raw : `#${raw}`;
  const noHash = withHash.replace(/^#/, "");

  // Shopify search query parser: özel karakterlerde tırnak şart
  // hem #LP-1009 hem LP-1009 denenir
  return `name:"${withHash}" OR name:"${noHash}"`;
}

async function shopifyGraphql(store, token, query, variables) {
  const url = `https://${store}/admin/api/2024-10/graphql.json`;
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": token,
    },
    body: JSON.stringify({ query, variables }),
  });

  const json = await resp.json();
  if (!resp.ok) {
    return { ok: false, status: resp.status, json };
  }
  return { ok: true, json };
}

async function handleShipmentToShopify(payload) {
  const store = process.env.SHOPIFY_STORE; // xxxx.myshopify.com
  const token = process.env.SHOPIFY_TOKEN; // Admin API access token
  if (!store || !token) return { ok: false, msg: "Missing SHOPIFY_STORE or SHOPIFY_TOKEN" };

  const status = payload?.status;
  if (status !== "SHIPPED") return { ok: true, msg: "Ignored" };

  const trackingNumber = payload?.handlerShipmentCode;
  const carrierCode = payload?.handler?.code || "Other";

  if (!trackingNumber) return { ok: false, msg: "Missing handlerShipmentCode" };

  // Shopify order input (LP-1009 gibi). Basit Kargo webhook bunu göndermiyorsa otomatik bağlamak için
  // Basit Kargo API ile order detail çekmek gerekir. Şimdilik payload’dan bekliyoruz.
  const orderInput =
    payload?.shopify_order ||
    payload?.orderNumber ||
    payload?.order_no ||
    payload?.code ||
    payload?.order;

  if (!orderInput) {
    return { ok: false, msg: "Missing Shopify order in payload (send shopify_order: LP-1009)" };
  }

  const q = buildOrderQuery(orderInput);
  if (!q) return { ok: false, msg: "Invalid order input" };

  // 1) Order + fulfillmentOrders al
  const findOrderQuery = `
    query ($q: String!) {
      orders(first: 1, query: $q) {
        edges {
          node {
            id
            name
            fulfillmentOrders(first: 10) {
              edges { node { id status } }
            }
          }
        }
      }
    }
  `;

  const findOrderRes = await shopifyGraphql(store, token, findOrderQuery, { q });
  if (!findOrderRes.ok) {
    return { ok: false, msg: `Shopify find order HTTP ${findOrderRes.status}`, detail: findOrderRes.json };
  }

  const edge = findOrderRes.json?.data?.orders?.edges?.[0];
  if (!edge) return { ok: false, msg: `Order not found (query: ${q})` };

  const foEdges = edge.node.fulfillmentOrders?.edges || [];
  const openFO =
    foEdges.map(e => e.node).find(n => n.status === "OPEN" || n.status === "IN_PROGRESS") ||
    foEdges[0]?.node;

  if (!openFO?.id) return { ok: false, msg: "No fulfillmentOrderId found" };

  // 2) Fulfillment create + tracking
  const fulfillMutation = `
    mutation ($fulfillment: FulfillmentV2Input!) {
      fulfillmentCreateV2(fulfillment: $fulfillment) {
        fulfillment {
          id
          status
          trackingInfo { number company url }
        }
        userErrors { field message }
      }
    }
  `;

  const fulfillVars = {
    fulfillment: {
      fulfillmentOrderId: openFO.id,
      notifyCustomer: true,
      trackingInfo: {
        number: trackingNumber,
        company: carrierCode,
      },
    },
  };

  const fulfillRes = await shopifyGraphql(store, token, fulfillMutation, fulfillVars);
  if (!fulfillRes.ok) {
    return { ok: false, msg: `Shopify fulfill HTTP ${fulfillRes.status}`, detail: fulfillRes.json };
  }

  const userErrors = fulfillRes.json?.data?.fulfillmentCreateV2?.userErrors || [];
  if (userErrors.length) {
    return { ok: false, msg: `Shopify userErrors: ${JSON.stringify(userErrors)}` };
  }

  return { ok: true, msg: `OK: ${edge.node.name} tracking=${trackingNumber}` };
}

// Basit Kargo webhook endpoint
app.post("/basitkargo-webhook", async (req, res) => {
  if (!checkKey(req, res)) return;

  try {
    const result = await handleShipmentToShopify(req.body);
    return res.status(result.ok ? 200 : 400).send(result.msg);
  } catch (e) {
    console.error(e);
    return res.status(500).send("Server error");
  }
});

// Manuel test endpoint (status'u SHIPPED yapar)
app.post("/manual-ship", async (req, res) => {
  if (!checkKey(req, res)) return;

  try {
    const payload = { ...req.body, status: "SHIPPED" };
    const result = await handleShipmentToShopify(payload);
    return res.status(result.ok ? 200 : 400).send(result.msg);
  } catch (e) {
    console.error(e);
    return res.status(500).send("Server error");
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log("Listening on", port));
