import express from "express";

const app = express();
app.use(express.json({ limit: "1mb" }));

app.get("/", (_, res) => res.status(200).send("OK"));

function checkKey(req, res) {
  const expected = process.env.WEBHOOK_KEY;
  if (!expected) return true; // istersen zorunlu yap
  const key = req.query.key;
  if (key !== expected) {
    res.status(401).send("Unauthorized");
    return false;
  }
  return true;
}

/**
 * Basit Kargo: order detail çek (id ile)
 * Dokümanda /v2/order/{id} var.
 */
async function basitKargoGetOrderById(id) {
  const token = process.env.BASITKARGO_TOKEN;
  if (!token) throw new Error("Missing BASITKARGO_TOKEN");

  const url = `https://basitkargo.com/api/v2/order/${encodeURIComponent(id)}`;
  const r = await fetch(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
  });

  const text = await r.text();
  if (!r.ok) {
    throw new Error(`BasitKargo HTTP ${r.status}: ${text}`);
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new Error("BasitKargo response is not JSON");
  }
}

/**
 * Basit Kargo order detail içinden Shopify sipariş adını çıkar.
 * Hedef: "#LP-1009" gibi bir string.
 *
 * Senin ekranda "SHOPIFY / 1007" gibi görünüyordu.
 * Bu fonksiyon farklı olası alanlardan çekip regex ile ayıklar.
 */
function extractShopifyOrderNameFromBasitKargo(bk) {
  // Olası alanlar (Basit Kargo response’ına göre genişlettik)
  const candidates = [
    bk?.content?.code,
    bk?.content?.orderCode,
    bk?.content?.reference,
    bk?.content?.ref,
    bk?.code,
    bk?.orderCode,
    bk?.reference,
    bk?.ref,
    bk?.sourceOrderCode,
    bk?.source?.orderCode,
    bk?.source?.code,
  ]
    .filter(Boolean)
    .map((x) => x.toString().trim())
    .filter((x) => x.length);

  // En iyi senaryo: zaten "#LP-1009"
  for (const s of candidates) {
    if (/^#?LP-\d+$/i.test(s)) {
      const noHash = s.replace(/^#/, "").toUpperCase();
      return `#${noHash}`;
    }
  }

  // "SHOPIFY / 1009" veya "SHOPIFY/1009" veya "LP-1009" veya "1009" gibi şeyleri yakala
  const joined = candidates.join(" | ");

  // Önce LP-1234 gibi
  let m = joined.match(/LP-\d+/i);
  if (m) return `#${m[0].toUpperCase()}`;

  // Sonra düz sayı (1009) -> LP-1009’a çevir
  m = joined.match(/\b(\d{3,8})\b/);
  if (m) return `#LP-${m[1]}`;

  // Bulamadı
  return null;
}

function buildOrderQuery(orderNameWithHash) {
  // orderNameWithHash: "#LP-1009"
  const raw = (orderNameWithHash ?? "").toString().trim();
  if (!raw) return null;

  const withHash = raw.startsWith("#") ? raw : `#${raw}`;
  const noHash = withHash.replace(/^#/, "");

  // Özel karakterlerde tırnak şart
  return `name:"${withHash}" OR name:"${noHash}"`;
}

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

  if (!r.ok) {
    throw new Error(`Shopify HTTP ${r.status}: ${text}`);
  }
  if (json.errors?.length) {
    throw new Error(`Shopify GraphQL errors: ${JSON.stringify(json.errors)}`);
  }

  return json;
}

async function handleBasitKargoWebhook(payload) {
  // 1) sadece SHIPPED
  if (payload?.status !== "SHIPPED") return { ok: true, msg: "Ignored" };

  const trackingNumber = payload?.handlerShipmentCode;
  const carrierName = payload?.handler?.name || payload?.handler?.code || "Other";
  if (!trackingNumber) return { ok: false, msg: "Missing handlerShipmentCode" };

  // 2) Shopify order name’i bul
  // Webhook’ta yok -> Basit Kargo API’den çek
  let shopifyOrderName =
    payload?.shopify_order ||
    payload?.orderNumber ||
    payload?.order_no ||
    payload?.code ||
    payload?.order ||
    null;

  // normalize: LP-1009 / #LP-1009
  if (shopifyOrderName) {
    const s = shopifyOrderName.toString().trim();
    if (/^#?LP-\d+$/i.test(s)) shopifyOrderName = `#${s.replace(/^#/, "").toUpperCase()}`;
    else if (/^\d{3,8}$/.test(s)) shopifyOrderName = `#LP-${s}`;
    else shopifyOrderName = s.startsWith("#") ? s : `#${s}`;
  } else {
    if (!payload?.id) {
      return { ok: false, msg: "Webhook payload missing id; cannot fetch BasitKargo order detail" };
    }
    const bk = await basitKargoGetOrderById(payload.id);
    const extracted = extractShopifyOrderNameFromBasitKargo(bk);
    if (!extracted) {
      return {
        ok: false,
        msg:
          "Basit Kargo order detail içinde Shopify sipariş kodu bulunamadı. " +
          "Sipariş oluştururken BasitKargo content.code alanına '#LP-xxxx' yazdırın veya response alanlarını paylaşın.",
      };
    }
    shopifyOrderName = extracted;
  }

  // 3) Shopify order’ı bul
  const q = buildOrderQuery(shopifyOrderName);
  if (!q) return { ok: false, msg: "Invalid Shopify order name" };

  const findOrderQuery = `
    query ($q: String!) {
      orders(first: 1, query: $q) {
        edges {
          node {
            id
            name
            fulfillmentOrders(first: 20) {
              edges { node { id status } }
            }
          }
        }
      }
    }
  `;

  const find = await shopifyGraphql(findOrderQuery, { q });
  const edge = find?.data?.orders?.edges?.[0];
  if (!edge) return { ok: false, msg: `Order not found (query: ${q})` };

  const foNodes = (edge.node.fulfillmentOrders?.edges || []).map((e) => e.node);
  const openFOs = foNodes.filter((n) => n.status === "OPEN" || n.status === "IN_PROGRESS");

  if (!openFOs.length) {
    return { ok: true, msg: `No OPEN/IN_PROGRESS fulfillmentOrder for ${edge.node.name} (already fulfilled/closed)` };
  }

  // 4) Her OPEN/IN_PROGRESS FO için fulfillment + tracking yaz
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
          company: carrierName, // "Aras Kargo" gibi
          number: trackingNumber,
        },
        lineItemsByFulfillmentOrder: [
          { fulfillmentOrderId: fo.id } // ✅ doğru kullanım
        ],
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
    msg: `OK: ${edge.node.name} tracking=${trackingNumber} fulfillments=${results.map((x) => x.fulfillmentId).join(",")}`,
  };
}

// Basit Kargo gerçek webhook endpoint
app.post("/basitkargo-webhook", async (req, res) => {
  if (!checkKey(req, res)) return;

  try {
    // İstersen debug için aç:
    // console.log("BASITKARGO PAYLOAD:", JSON.stringify(req.body));

    const result = await handleBasitKargoWebhook(req.body);
    return res.status(result.ok ? 200 : 400).send(result.msg);
  } catch (e) {
    console.error(e);
    return res.status(500).send(e?.message || "Server error");
  }
});

// Manuel test endpoint (BasitKargo payload gibi davranır)
app.post("/manual-ship", async (req, res) => {
  if (!checkKey(req, res)) return;

  try {
    // Buraya iki şekilde test atabilirsin:
    // 1) Basit Kargo id ile: { id: "XXX-XXX-XXX", handlerShipmentCode:"...", handler:{name:"Aras Kargo"} }
    // 2) Shopify order ile: { shopify_order:"LP-1009", handlerShipmentCode:"...", handler:{name:"Aras Kargo"} }
    const payload = { ...req.body, status: "SHIPPED" };

    const result = await handleBasitKargoWebhook(payload);
    return res.status(result.ok ? 200 : 400).send(result.msg);
  } catch (e) {
    console.error(e);
    return res.status(500).send(e?.message || "Server error");
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log("Listening on", port));
