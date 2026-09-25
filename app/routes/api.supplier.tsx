import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { unauthenticated } from "../shopify.server";
import {
  assertSupplierHmac,
  normalizeOrderGid,
  orderNumericId,
  resolveAllowedShop,
} from "../utils/hmac-auth.server";
import {
  assertTransition,
  MAX_PORTRAIT_VERSIONS,
  type BusinessStatus,
} from "../utils/business-status.server";
import {
  createOrderFulfillment,
  enableBusinessStatusCustomerRead,
  fetchOrderDetailForSupplier,
  getOrderBusinessStatus,
  setOrderBusinessStatus,
} from "../utils/shopify-order.server";
import {
  createUploadSignedUrl,
  getSupplierOrder,
  insertPortraitVersion,
  listModificationRequests,
  listPortraitVersions,
  listSupplierOrders,
  setSupplierOrderStatus,
  signedReadUrl,
  upsertSupplierOrder,
} from "../utils/supplier-store.server";

function json(data: unknown, status = 200) {
  return Response.json(data, { status });
}

async function parseSignedBody(request: Request) {
  const rawBody = await request.text();
  const hmac = assertSupplierHmac(request, rawBody);
  if (!hmac.ok) {
    return { error: json({ ok: false, error: hmac.error }, hmac.status) };
  }
  try {
    return { body: JSON.parse(rawBody) as Record<string, unknown>, rawBody };
  } catch {
    return { error: json({ ok: false, error: "Invalid JSON body" }, 400) };
  }
}

export const loader = async (_args: LoaderFunctionArgs) => {
  return json({ ok: true, service: "supplier-api" });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return json({ ok: false, error: "Method not allowed" }, 405);
  }

  const parsed = await parseSignedBody(request);
  if ("error" in parsed && parsed.error) return parsed.error;
  const body = parsed.body!;

  const actionType = String(body.action || "");
  const shop = resolveAllowedShop(
    typeof body.shop === "string" ? body.shop : null,
  );
  if (!shop) {
    return json({ ok: false, error: "Shop not allowed" }, 403);
  }

  let admin;
  try {
    ({ admin } = await unauthenticated.admin(shop));
  } catch (err) {
    console.error("[supplier-api] admin session failed", err);
    return json({ ok: false, error: "Admin session unavailable" }, 503);
  }

  if (actionType === "enable_customer_read") {
    const result = await enableBusinessStatusCustomerRead(admin);
    return json({ ok: result.ok, message: result.message }, result.ok ? 200 : 422);
  }

  if (actionType === "list_orders") {
    const tab = (body.tab as "action" | "waiting" | "done") || "action";
    const rows = await listSupplierOrders(shop, tab);
    return json({
      ok: true,
      tab,
      orders: rows.map((row) => ({
        id: row.shopify_order_id,
        orderName: row.order_name,
        email: row.customer_email,
        businessStatus: row.business_status,
        versionCount: row.version_count,
        modificationCount: row.modification_count,
        placedAt: row.placed_at,
        trackingCompany: row.tracking_company,
        trackingNumber: row.tracking_number,
      })),
    });
  }

  if (actionType === "order_detail") {
    const orderId = String(body.orderId || "");
    if (!orderId) return json({ ok: false, error: "orderId required" }, 400);
    const shopifyOrderId = orderNumericId(orderId);
    const ownerId = normalizeOrderGid(orderId);
    const shopifyOrder = await fetchOrderDetailForSupplier(admin, ownerId);
    if (!shopifyOrder) {
      return json({ ok: false, error: "Order not found" }, 404);
    }

    let index = await getSupplierOrder(shop, shopifyOrderId);
    if (!index) {
      index = await upsertSupplierOrder({
        shop,
        shopifyOrderId,
        orderName: shopifyOrder.name,
        customerEmail: shopifyOrder.email,
        businessStatus: await getOrderBusinessStatus(admin, ownerId),
        placedAt: shopifyOrder.createdAt,
      });
    }

    const versions = await listPortraitVersions(shop, shopifyOrderId);
    const requests = await listModificationRequests(shop, shopifyOrderId);
    const enrichedVersions = await Promise.all(
      versions.map(async (v) => ({
        versionNumber: v.version_number,
        imageUrl: await signedReadUrl(v.image_path),
        videoUrl: v.video_path ? await signedReadUrl(v.video_path) : null,
        createdAt: v.created_at,
      })),
    );

    return json({
      ok: true,
      order: {
        id: shopifyOrderId,
        gid: ownerId,
        name: shopifyOrder.name,
        email: shopifyOrder.email,
        createdAt: shopifyOrder.createdAt,
        financialStatus: shopifyOrder.displayFinancialStatus,
        fulfillmentStatus: shopifyOrder.displayFulfillmentStatus,
        total: shopifyOrder.totalPriceSet?.shopMoney,
        shippingAddress: shopifyOrder.shippingAddress,
        lineItems: shopifyOrder.lineItems?.nodes || [],
        originalPhotoUrl: shopifyOrder.originalPhoto?.value || null,
        paintingUrl: shopifyOrder.paintingUrl?.value || null,
        paintingStyle: shopifyOrder.paintingStyle?.value || null,
        giftMessage: shopifyOrder.giftMessage?.value || null,
        businessStatus: index.business_status,
        versionCount: index.version_count,
        modificationCount: index.modification_count,
        trackingCompany: index.tracking_company,
        trackingNumber: index.tracking_number,
        versions: enrichedVersions,
        modificationRequests: requests.map((r) => ({
          againstVersion: r.against_version,
          createdAt: r.created_at,
          notes: r.notes.map((n) => ({
            id: n.id,
            index: n.note_index,
            text: n.text,
            selection: {
              x: Number(n.x),
              y: Number(n.y),
              width: Number(n.width),
              height: Number(n.height),
            },
          })),
        })),
      },
    });
  }

  if (actionType === "create_upload_url") {
    const orderId = String(body.orderId || "");
    const kind = body.kind === "video" ? "video" : "image";
    const contentType = String(body.contentType || "image/jpeg");
    if (!orderId) return json({ ok: false, error: "orderId required" }, 400);

    const shopifyOrderId = orderNumericId(orderId);
    const ownerId = normalizeOrderGid(orderId);
    const current = await getOrderBusinessStatus(admin, ownerId);
    if (current !== "order_placed" && current !== "supplier_modification") {
      return json(
        { ok: false, error: `Cannot upload in status ${current}` },
        409,
      );
    }

    let index = await getSupplierOrder(shop, shopifyOrderId);
    if (!index) {
      index = await upsertSupplierOrder({
        shop,
        shopifyOrderId,
        businessStatus: current,
      });
    }
    const nextVersion = (index.version_count || 0) + 1;
    if (nextVersion > MAX_PORTRAIT_VERSIONS) {
      return json({ ok: false, error: "Maximum portrait versions reached" }, 409);
    }

    const signed = await createUploadSignedUrl({
      shop,
      shopifyOrderId,
      kind,
      versionNumber: nextVersion,
      contentType,
    });
    return json({
      ok: true,
      versionNumber: nextVersion,
      path: signed.path,
      uploadUrl: signed.uploadUrl,
      token: signed.token,
    });
  }

  if (actionType === "confirm_upload") {
    const orderId = String(body.orderId || "");
    const imagePath = String(body.imagePath || "");
    const videoPath = body.videoPath ? String(body.videoPath) : null;
    if (!orderId || !imagePath) {
      return json({ ok: false, error: "orderId and imagePath required" }, 400);
    }

    const shopifyOrderId = orderNumericId(orderId);
    const ownerId = normalizeOrderGid(orderId);
    const current = await getOrderBusinessStatus(admin, ownerId);
    const next: BusinessStatus = "portrait_review";
    try {
      assertTransition(current, next);
    } catch {
      return json(
        { ok: false, error: `Cannot confirm upload from status ${current}` },
        409,
      );
    }

    let index = await getSupplierOrder(shop, shopifyOrderId);
    if (!index) {
      index = await upsertSupplierOrder({
        shop,
        shopifyOrderId,
        businessStatus: current,
      });
    }
    const nextVersion = (index.version_count || 0) + 1;
    if (nextVersion > MAX_PORTRAIT_VERSIONS) {
      return json({ ok: false, error: "Maximum portrait versions reached" }, 409);
    }

    await insertPortraitVersion({
      shop,
      shopifyOrderId,
      versionNumber: nextVersion,
      imagePath,
      videoPath,
    });
    await setOrderBusinessStatus(admin, ownerId, next);
    await setSupplierOrderStatus(shop, shopifyOrderId, next, {
      versionCount: nextVersion,
    });

    return json({
      ok: true,
      businessStatus: next,
      versionNumber: nextVersion,
    });
  }

  if (actionType === "ship") {
    const orderId = String(body.orderId || "");
    const company = String(body.trackingCompany || "").trim();
    const number = String(body.trackingNumber || "").trim();
    if (!orderId || !company || !number) {
      return json(
        { ok: false, error: "orderId, trackingCompany, trackingNumber required" },
        400,
      );
    }

    const shopifyOrderId = orderNumericId(orderId);
    const ownerId = normalizeOrderGid(orderId);
    const current = await getOrderBusinessStatus(admin, ownerId);
    const next: BusinessStatus = "shipped";
    try {
      assertTransition(current, next);
    } catch {
      return json(
        { ok: false, error: `Cannot ship from status ${current}` },
        409,
      );
    }

    try {
      await createOrderFulfillment(admin, ownerId, { company, number });
    } catch (err) {
      return json(
        {
          ok: false,
          error: err instanceof Error ? err.message : "Fulfillment failed",
        },
        422,
      );
    }

    await setOrderBusinessStatus(admin, ownerId, next);
    await setSupplierOrderStatus(shop, shopifyOrderId, next, {
      trackingCompany: company,
      trackingNumber: number,
    });

    return json({
      ok: true,
      businessStatus: next,
      trackingCompany: company,
      trackingNumber: number,
    });
  }

  return json({ ok: false, error: `Unknown action: ${actionType}` }, 400);
};
