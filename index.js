import express from "express";

const app = express();
app.use(express.json({ limit: "1mb" }));

app.get("/", (_, res) => res.status(200).send("OK"));

async function handleBasitKargoWebhook(p) {
  // sadece SHIPPED
  if (p.status !== "SHIPPED") return { ok: true, msg: "Ignored" };

  const trackingNumber = p.handlerShipmentCode;
  const carrierCode = p?.handler?.code || "Other";
  if (!trackingNumber) return { ok: false, msg: "Missing handlerShipmentCode" };

  // Shopify sipariş no (manuel testte buradan vereceğiz)
  const orderNo = p.shopify_order || p.orderNumber || p.order_no || p.code || p.order;
  if (!orderNo) return { ok: false, msg: "Missing Shopify order number (e.g. 1007)" };

  const orderName = orderNo.toString().startsWith("#") ? orderNo.toString() : `#${orderNo}`;

  const shopifyGraphqlUrl = `https://${process.env.SHOPIFY_STORE}/admin/api/2024-10/graphql.json`;

  // 1) order bul
  const findOrderRes = await fetch(shopifyGraphqlUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": process.env.SHOPIFY_TOKEN
    },
    body: JSON.stringify({
      query: `
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
      `,
      variables: { q: `name:${orderName}` }
    })
  });

  const findOrderJson = await findOrderRes.json();
  const orderEdge = findOrderJson?.data?.orders?.edges?.[0];
  if (!orderEdge) return { ok: false, msg: `Order not found for ${orderName}` };

  const foEdges = orderEdge.node.fulfillmentOrders.edges || [];
  const openFO =
    foEdges.map(e => e.node).find(x => x.status === "OPEN" || x.status === "IN_PROGRESS") ||
    foEdges[0]?.node;

  if (!openFO?.id) return { ok: false, msg: "No fulfillmentOrderId found" };

  // 2) fulfillment + tracking yaz
  const fulfillRes = await fetch(shopifyGraphqlUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": process.env.SHOPIFY_TOKEN
    },
    body: JSON.stringify({
      query: `
        mutation ($fulfillment: FulfillmentV2Input!) {
          fulfillmentCreateV2(fulfillment: $fulfillment) {
            fulfillment { id status trackingInfo { number company url } }
            userErrors { field message }
          }
        }
      `,
      variables: {
        fulfillment: {
          fulfillmentOrderId: openFO.id,
          notifyCustomer: true,
          trackingInfo: { number: trackingNumber, company: carrierCode }
        }
      }
    })
  });

  const fulfillJson = await fulfillRes.json();
  const errors = fulfillJson?.data?.fulfillmentCreateV2?.userErrors;
  if (errors?.length) return { ok: false, msg: `Shopify userErrors: ${JSON.stringify(errors)}` };

  return { ok: true, msg: "OK" };
}

// Basit Kargo gerçek webhook endpoint'i
app.post("/basitkargo-webhook", async (req, res) => {
  try {
    const key = req.query.key;
    if (process.env.WEBHOOK_KEY && key !== process.env.WEBHOOK_KEY) {
      return res.status(401).send("Unauthorized");
    }

    const result = await handleBasitKargoWebhook(req.body);
    return res.status(result.ok ? 200 : 400).send(result.msg);
  } catch (e) {
    console.error(e);
    return res.status(500).send("Server error");
  }
});

// Manuel tetikleme endpoint'i (panelden “yolda” yapamadığın için)
app.post("/manual-ship", async (req, res) => {
  try {
    const key = req.query.key;
    if (process.env.WEBHOOK_KEY && key !== process.env.WEBHOOK_KEY) {
      return res.status(401).send("Unauthorized");
    }

    // Burada sen payload gönderiyorsun: shopify_order, handlerShipmentCode, handler.code
    const p = { ...req.body, status: "SHIPPED" };
    const result = await handleBasitKargoWebhook(p);
    return res.status(result.ok ? 200 : 400).send(result.msg);
  } catch (e) {
    console.error(e);
    return res.status(500).send("Server error");
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log("Listening on", port));
