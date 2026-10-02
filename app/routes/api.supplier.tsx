import type { ActionFunctionArgs } from "react-router";
import { unauthenticated } from "../shopify.server";
import {
  assertSupplierHmac,
  normalizeOrderGid,
  orderNumericId,
  resolveAllowedShop,
} from "../utils/hmac-auth.server";
import { MAX_PORTRAIT_VERSIONS } from "../utils/business-status.server";
import {
  createOrderFulfillment,
  effectiveBusinessStatus,
  enableBusinessStatusCustomerRead,
  fetchOrderDetailForSupplier,
  fetchOrderGate,
  listShopifyOrdersForSupplier,
  orderBlockReason,
  syncBusinessStatusMetafield,
  trackingFromFulfillments,
  type OrderGate,
} from "../utils/shopify-order.server";
import {
  createUploadSignedUrl,
  deletePortraitVersion,
  deleteStalePortraitRows,
  getSupplierOrder,
  insertPortraitVersion,
  isValidUploadPath,
  loadOrderPortraitProgress,
  loadPortraitProgress,
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

  let admin: Awaited<ReturnType<typeof unauthenticated.admin>>["admin"];
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
    try {
      const rows = await listShopifyOrdersForSupplier(admin, tab);
      const progress = await loadPortraitProgress(
        shop,
        rows.map((row) => ({ shopifyOrderId: row.id, businessStatus: row.businessStatus })),
      );
      return json({
        ok: true,
        tab,
        orders: rows.map((row) => {
          const p = progress.get(row.id);
          const latestRequest = p?.requests[p.requests.length - 1];
          return {
            id: row.id,
            orderName: row.orderName,
            email: row.email,
            businessStatus: row.businessStatus,
            versionCount: p?.versionCount ?? 0,
            modificationCount: p?.modificationCount ?? 0,
            latestNoteCount: latestRequest?.notes.length ?? 0,
            placedAt: row.placedAt,
            trackingCompany: row.trackingCompany,
            trackingNumber: row.trackingNumber,
          };
        }),
      });
    } catch (err) {
      console.error("[supplier-api] list_orders failed", err);
      return json(
        { ok: false, error: err instanceof Error ? err.message : "订单加载失败" },
        500,
      );
    }
  }

  const orderId = String(body.orderId || "");
  if (!orderId) return json({ ok: false, error: "orderId required" }, 400);
  const shopifyOrderId = orderNumericId(orderId);
  const ownerId = normalizeOrderGid(orderId);

  async function loadIndex(gate: OrderGate) {
    const existing = await getSupplierOrder(shop!, shopifyOrderId);
    if (existing) return existing;
    return upsertSupplierOrder({
      shop: shop!,
      shopifyOrderId,
      orderName: gate.name,
      customerEmail: gate.email,
      businessStatus: gate.businessStatus,
      placedAt: gate.createdAt,
    });
  }

  /** Live Shopify state for write actions; a Response when the order may not be worked on. */
  async function loadWritableGate(): Promise<OrderGate | Response> {
    const gate = await fetchOrderGate(admin, ownerId);
    if (!gate) return json({ ok: false, error: "Order not found" }, 404);
    if (gate.blockReason) return json({ ok: false, error: gate.blockReason }, 409);
    return gate;
  }

  if (actionType === "order_detail") {
    const shopifyOrder = await fetchOrderDetailForSupplier(admin, ownerId);
    if (!shopifyOrder) {
      return json({ ok: false, error: "Order not found" }, 404);
    }
    const metafieldStatus = shopifyOrder.businessStatus?.value || null;
    const businessStatus = effectiveBusinessStatus(
      metafieldStatus,
      shopifyOrder.displayFulfillmentStatus,
    );
    await syncBusinessStatusMetafield(admin, { id: ownerId, metafieldStatus, businessStatus });

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
    await reconcileSupplierOrder(index, businessStatus);

    const progress = await loadOrderPortraitProgress(shop, shopifyOrderId, businessStatus);
    const tracking = trackingFromFulfillments(shopifyOrder.fulfillments);
    const urls = await signedReadUrls(
      progress.versions.flatMap((v) => [v.image_path, v.video_path || ""]),
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
        blockedReason: orderBlockReason(shopifyOrder),
        total: shopifyOrder.totalPriceSet?.shopMoney,
        shippingAddress: shopifyOrder.shippingAddress,
        lineItems: shopifyOrder.lineItems?.nodes || [],
        originalPhotoUrl: shopifyOrder.originalPhoto?.value || null,
        paintingUrl: shopifyOrder.paintingUrl?.value || null,
        paintingStyle: shopifyOrder.paintingStyle?.value || null,
        giftMessage: shopifyOrder.giftMessage?.value || null,
        businessStatus,
        versionCount: progress.versionCount,
        modificationCount: progress.modificationCount,
        nextVersion: progress.nextVersion,
        trackingCompany: tracking.company,
        trackingNumber: tracking.number,
        versions: progress.versions.map((v) => ({
          versionNumber: v.version_number,
          imageUrl: urls.get(v.image_path) || null,
          videoUrl: v.video_path ? urls.get(v.video_path) || null : null,
          createdAt: v.created_at,
        })),
        modificationRequests: progress.requests.map((r) => ({
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

    const gate = await loadWritableGate();
    if (gate instanceof Response) return gate;
    const current = gate.businessStatus;
    if (current !== "order_placed" && current !== "supplier_modification") {
      return json({ ok: false, error: `Cannot upload in status ${current}` }, 409);
    }

    const { nextVersion } = await loadOrderPortraitProgress(shop, shopifyOrderId, current);
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

    const gate = await loadWritableGate();
    if (gate instanceof Response) return gate;
    const current = gate.businessStatus;
    const progress = await loadOrderPortraitProgress(shop, shopifyOrderId, current);
    const nextVersion = progress.nextVersion;
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

    const index = await loadIndex(gate);
    const outcome = await runTransition({
      admin,
      ownerId,
      index,
      current,
      next: "portrait_review",
      apply: async () => {
        await deleteStalePortraitRows(progress);
        return insertPortraitVersion({
          shop,
          shopifyOrderId,
          versionNumber: nextVersion,
          imagePath,
          videoPath,
        });
      },
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

    const gate = await loadWritableGate();
    if (gate instanceof Response) return gate;
    if (gate.businessStatus === "shipped") {
      await syncBusinessStatusMetafield(admin, gate);
      return json({ ok: false, error: "This order is already fulfilled in Shopify." }, 409);
    }
    const index = await loadIndex(gate);
    const tracking = { company, number };

    // Retrying after a failed status write is safe: fulfillment skips closed fulfillment orders.
    const outcome = await runTransition({
      admin,
      ownerId,
      index,
      current: gate.businessStatus,
      next: "shipped",
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
