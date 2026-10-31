import type { ActionFunctionArgs } from "react-router";
import { assertAccountHmac, normalizeOrderGid } from "../utils/hmac-auth.server";
import {
  adminForOrderLink,
  listCustomerOrderIds,
  loadOrderLinkSnapshot,
  publicShopKey,
  readOrderLink,
} from "../utils/order-link.server";

function json(data: unknown, status = 200) {
  return Response.json(data, { status });
}

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return json({ ok: false, error: "Method not allowed" }, 405);
  }
  const rawBody = await request.text();
  const hmac = assertAccountHmac(request, rawBody);
  if (!hmac.ok) return json({ ok: false, error: hmac.error }, hmac.status);

  let body: { token?: string; orderId?: string };
  try {
    body = JSON.parse(rawBody) as typeof body;
  } catch {
    return json({ ok: false, error: "Invalid JSON" }, 400);
  }
  const claims = readOrderLink(body.token || "");
  if (!claims) return json({ ok: false, error: "invalid_token" }, 401);
  if (body.orderId && normalizeOrderGid(body.orderId) !== claims.orderId) {
    return json({ ok: false, error: "order_mismatch" }, 403);
  }

  try {
    const { admin } = await adminForOrderLink(claims.shop);
    const loaded = await loadOrderLinkSnapshot(admin, claims.shop, claims.orderId);
    if (!loaded) return json({ ok: false, error: "Order not found" }, 404);
    if (loaded.snapshot.customerId !== claims.customerId) {
      return json({ ok: false, error: "Forbidden" }, 403);
    }
    if (loaded.version !== claims.version) {
      return json({ ok: false, error: "version_changed" }, 401);
    }
    const ids = await listCustomerOrderIds(admin, claims.customerId).catch((err) => {
      console.error("[account/order-link] customer orders skipped", err);
      return [] as string[];
    });
    const ordered = ids.includes(claims.orderId) ? ids : [claims.orderId, ...ids];
    const orders = [];
    for (const id of ordered) {
      if (id === loaded.snapshot.id) {
        orders.push(loaded.snapshot);
        continue;
      }
      const next = await loadOrderLinkSnapshot(admin, claims.shop, id).catch(() => null);
      if (next?.snapshot.customerId === claims.customerId) orders.push(next.snapshot);
    }
    return json({
      ok: true,
      shop: claims.shop,
      shopKey: publicShopKey(claims.shop),
      exp: claims.exp,
      order: loaded.snapshot,
      orders,
    });
  } catch (err) {
    console.error("[account/order-link]", err);
    return json({ ok: false, error: "Could not open the order" }, 500);
  }
};
