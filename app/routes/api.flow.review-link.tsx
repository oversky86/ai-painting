import type { ActionFunctionArgs } from "react-router";
import { canonicalShop, DEV_SHOP, LIVE_SHOP } from "../utils/shops.server";
import { normalizeOrderGid } from "../utils/hmac-auth.server";
import {
  adminForOrderLink,
  loadOrderLinkSnapshot,
  orderLinkUrl,
  verifyShopifyFlowHmac,
} from "../utils/order-link.server";

function json(data: unknown, status = 200) {
  return Response.json(data, { status });
}

function orderIdFromProperties(properties: Record<string, unknown> | undefined): string {
  const value =
    properties?.order_id ||
    properties?.orderId ||
    properties?.Order;
  return typeof value === "string" ? value.trim() : "";
}

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return json({ message: "Method not allowed" }, 405);
  }
  const rawBody = await request.text();
  const hmac =
    request.headers.get("x-shopify-hmac-sha256") ||
    request.headers.get("http-x-shopify-hmac-sha256");
  if (!verifyShopifyFlowHmac(rawBody, hmac)) {
    return json({ message: "Invalid signature" }, 401);
  }

  let payload: {
    handle?: string;
    shopify_domain?: string;
    properties?: Record<string, unknown>;
  };
  try {
    payload = JSON.parse(rawBody) as typeof payload;
  } catch {
    return json({ message: "Invalid JSON" }, 400);
  }
  if (payload.handle && payload.handle !== "generate-order-link") {
    return json({ message: "Unknown action" }, 400);
  }

  const shop = canonicalShop(payload.shopify_domain || "");
  if (shop !== DEV_SHOP && shop !== LIVE_SHOP) {
    return json({ message: "Shop not allowed" }, 403);
  }
  const orderId = normalizeOrderGid(orderIdFromProperties(payload.properties));
  if (!orderId.startsWith("gid://shopify/Order/")) {
    return json({ message: "Order is required" }, 422);
  }

  try {
    const { admin } = await adminForOrderLink(shop);
    const loaded = await loadOrderLinkSnapshot(admin, shop, orderId);
    if (!loaded) return json({ message: "Order not found" }, 404);
    const reviewUrl = orderLinkUrl({
      shop,
      orderId: loaded.snapshot.id,
      customerId: loaded.snapshot.customerId,
      version: loaded.version,
      exp: Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60,
    });
    return json({ return_value: { review_url: reviewUrl } });
  } catch (err) {
    console.error("[flow/review-link]", err);
    return json({ message: "Could not create the order link" }, 500);
  }
};
