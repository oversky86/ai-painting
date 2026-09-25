import type { ActionFunctionArgs } from "react-router";
import { unauthenticated } from "../shopify.server";
import {
  assertSupplierHmac,
  normalizeOrderGid,
  orderNumericId,
  resolveAllowedShop,
} from "../utils/hmac-auth.server";
import {
  MAX_PORTRAIT_VERSIONS,
  normalizeBusinessStatus,
} from "../utils/business-status.server";
import {
  createOrderFulfillment,
  enableBusinessStatusCustomerRead,
  fetchOrderDetailForSupplier,
  getOrderBusinessStatus,
} from "../utils/shopify-order.server";
import {
  createUploadSignedUrl,
  deletePortraitVersion,
  getSupplierOrder,
  insertPortraitVersion,
  isValidUploadPath,
  latestNoteCounts,
  listModificationRequests,
  listPortraitVersions,
  listSupplierOrders,
  reconcileSupplierOrder,
  signedReadUrls,
  upsertSupplierOrder,
} from "../utils/supplier-store.server";
import { runTransition, TransitionAbort } from "../utils/status-transition.server";

function json(data: unknown, status = 200) {
  return Response.json(data, { status });
}

const UPLOAD_CONTENT_TYPES = {
  image: ["image/jpeg", "image/png", "image/webp"],
  video: ["video/mp4", "video/webm", "video/quicktime"],
} as const;

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

export const loader = async () => {
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
    const noteCounts = await latestNoteCounts(
      shop,
      rows
        .filter((row) => row.business_status === "supplier_modification")
        .map((row) => row.shopify_order_id),
    );
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
        latestNoteCount: noteCounts.get(row.shopify_order_id) ?? 0,
        placedAt: row.placed_at,
        trackingCompany: row.tracking_company,
        trackingNumber: row.tracking_number,
      })),
    });
  }

  const orderId = String(body.orderId || "");
  if (!orderId) return json({ ok: false, error: "orderId required" }, 400);
  const shopifyOrderId = orderNumericId(orderId);
  const ownerId = normalizeOrderGid(orderId);

  async function loadIndex(current: ReturnType<typeof normalizeBusinessStatus>) {
    const existing = await getSupplierOrder(shop!, shopifyOrderId);
    if (existing) return existing;
    return upsertSupplierOrder({
      shop: shop!,
      shopifyOrderId,
      businessStatus: current,
    });
  }

  if (actionType === "order_detail") {
    const shopifyOrder = await fetchOrderDetailForSupplier(admin, ownerId);
    if (!shopifyOrder) {
      return json({ ok: false, error: "Order not found" }, 404);
    }
    const businessStatus = normalizeBusinessStatus(shopifyOrder.businessStatus?.value);

    let index = await getSupplierOrder(shop, shopifyOrderId);
    if (!index) {
      index = await upsertSupplierOrder({
        shop,
        shopifyOrderId,
        orderName: shopifyOrder.name,
        customerEmail: shopifyOrder.email,
        businessStatus,
        placedAt: shopifyOrder.createdAt,
      });
    }
    index = await reconcileSupplierOrder(index, businessStatus);

    const versions = await listPortraitVersions(shop, shopifyOrderId);
    const requests = await listModificationRequests(shop, shopifyOrderId);
    const urls = await signedReadUrls(
      versions.flatMap((v) => [v.image_path, v.video_path || ""]),
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
        businessStatus,
        versionCount: index.version_count,
        modificationCount: index.modification_count,
        trackingCompany: index.tracking_company,
        trackingNumber: index.tracking_number,
        versions: versions.map((v) => ({
          versionNumber: v.version_number,
          imageUrl: urls.get(v.image_path) || null,
          videoUrl: v.video_path ? urls.get(v.video_path) || null : null,
          createdAt: v.created_at,
        })),
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
    const kind = body.kind === "video" ? "video" : "image";
    const contentType = String(body.contentType || "");
    if (!(UPLOAD_CONTENT_TYPES[kind] as readonly string[]).includes(contentType)) {
      return json({ ok: false, error: `Unsupported ${kind} type: ${contentType || "unknown"}` }, 400);
    }

    const current = await getOrderBusinessStatus(admin, ownerId);
    if (current !== "order_placed" && current !== "supplier_modification") {
      return json({ ok: false, error: `Cannot upload in status ${current}` }, 409);
    }

    const index = await loadIndex(current);
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
    const imagePath = String(body.imagePath || "");
    const videoPath = String(body.videoPath || "");
    if (!imagePath || !videoPath) {
      return json(
        { ok: false, error: "Both the portrait image and the studio video are required" },
        400,
      );
    }

    const current = await getOrderBusinessStatus(admin, ownerId);
    const index = await loadIndex(current);
    const nextVersion = (index.version_count || 0) + 1;
    if (nextVersion > MAX_PORTRAIT_VERSIONS) {
      return json({ ok: false, error: "Maximum portrait versions reached" }, 409);
    }

    const slot = { shop, shopifyOrderId, versionNumber: nextVersion };
    const [imageOk, videoOk] = await Promise.all([
      isValidUploadPath({ ...slot, path: imagePath, kind: "image" }),
      isValidUploadPath({ ...slot, path: videoPath, kind: "video" }),
    ]);
    if (!imageOk || !videoOk) {
      return json(
        {
          ok: false,
          error: `Uploaded files do not match version ${nextVersion} of this order. Upload them again.`,
        },
        400,
      );
    }

    const outcome = await runTransition({
      admin,
      ownerId,
      index,
      current,
      next: "portrait_review",
      extra: { versionCount: nextVersion },
      apply: () =>
        insertPortraitVersion({
          shop,
          shopifyOrderId,
          versionNumber: nextVersion,
          imagePath,
          videoPath,
        }),
      undo: (version) => deletePortraitVersion(version.id),
    });
    if (!outcome.ok) return json({ ok: false, error: outcome.error }, outcome.status);

    return json({
      ok: true,
      businessStatus: "portrait_review",
      versionNumber: nextVersion,
    });
  }

  if (actionType === "ship") {
    const company = String(body.trackingCompany || "").trim();
    const number = String(body.trackingNumber || "").trim();
    if (!company || !number) {
      return json(
        { ok: false, error: "trackingCompany and trackingNumber required" },
        400,
      );
    }

    const current = await getOrderBusinessStatus(admin, ownerId);
    const index = await loadIndex(current);
    const tracking = { company, number };

    // Retrying after a failed status write is safe: fulfillment skips closed fulfillment orders.
    const outcome = await runTransition({
      admin,
      ownerId,
      index,
      current,
      next: "shipped",
      extra: { trackingCompany: company, trackingNumber: number },
      irreversible: true,
      apply: async () => {
        try {
          return await createOrderFulfillment(admin, ownerId, tracking);
        } catch (err) {
          throw new TransitionAbort(
            422,
            err instanceof Error ? err.message : "Fulfillment failed",
          );
        }
      },
    });
    if (!outcome.ok) return json({ ok: false, error: outcome.error }, outcome.status);

    return json({
      ok: true,
      businessStatus: "shipped",
      trackingCompany: company,
      trackingNumber: number,
    });
  }

  return json({ ok: false, error: `Unknown action: ${actionType}` }, 400);
};
