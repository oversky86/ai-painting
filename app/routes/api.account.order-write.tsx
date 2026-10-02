import type { ActionFunctionArgs } from "react-router";
import { unauthenticated } from "../shopify.server";
import {
  assertAccountHmac,
  normalizeCustomerGid,
  normalizeOrderGid,
  orderNumericId,
  resolveAllowedShop,
} from "../utils/hmac-auth.server";
import { canRequestModification } from "../utils/business-status.server";
import {
  effectiveBusinessStatus,
  fetchOrderGates,
  orderBlockReason,
} from "../utils/shopify-order.server";
import {
  deleteModificationRequest,
  deleteStalePortraitRows,
  getSupplierOrder,
  insertModificationRequest,
  loadOrderPortraitProgress,
  upsertSupplierOrder,
} from "../utils/supplier-store.server";
import { buildPortraitHistories } from "../utils/portrait-history.server";
import { runTransition } from "../utils/status-transition.server";

const MAX_BATCH_ORDERS = 25;

function json(data: unknown, status = 200) {
  return Response.json(data, { status });
}

function isEditable(order: {
  cancelledAt?: string | null;
  closedAt?: string | null;
  displayFulfillmentStatus?: string | null;
}): { ok: boolean; reason?: string } {
  if (order.cancelledAt) return { ok: false, reason: "Order cancelled" };
  if (order.closedAt) return { ok: false, reason: "Order closed" };
  const status = (order.displayFulfillmentStatus || "").toUpperCase();
  if (
    status === "FULFILLED" ||
    status.includes("DELIVERED") ||
    status === "IN_TRANSIT" ||
    status === "OUT_FOR_DELIVERY"
  ) {
    return { ok: false, reason: "Shipping already started" };
  }
  return { ok: true };
}

type NoteInput = {
  text?: string;
  selection?: { x?: number; y?: number; width?: number; height?: number };
};

function parseNotes(body: {
  notes?: NoteInput[];
  note?: string;
}): Array<{
  text: string;
  selection: { x: number; y: number; width: number; height: number };
}> {
  if (Array.isArray(body.notes) && body.notes.length) {
    return body.notes
      .map((n, index) => {
        const text = String(n?.text || "").trim();
        if (!text) return null;
        const s = n.selection || {};
        return {
          text: text.slice(0, 2000),
          selection: {
            x: Number(s.x ?? 12 + index * 8),
            y: Number(s.y ?? 12 + index * 12),
            width: Number(s.width ?? 24),
            height: Number(s.height ?? 22),
          },
        };
      })
      .filter(Boolean) as Array<{
      text: string;
      selection: { x: number; y: number; width: number; height: number };
    }>;
  }

  if (body.note) {
    try {
      const parsed = JSON.parse(body.note) as { notes?: NoteInput[] };
      if (Array.isArray(parsed.notes)) {
        return parseNotes({ notes: parsed.notes });
      }
    } catch {
      const text = body.note.trim();
      if (text) {
        return [
          {
            text: text.slice(0, 2000),
            selection: { x: 12, y: 12, width: 24, height: 22 },
          },
        ];
      }
    }
  }
  return [];
}

export const loader = async () => {
  return json({ ok: true });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return json({ ok: false, error: "Method not allowed" }, 405);
  }

  const rawBody = await request.text();
  const hmac = assertAccountHmac(request, rawBody);
  if (!hmac.ok) return json({ ok: false, error: hmac.error }, hmac.status);

  let body: {
    type?: "review" | "gift" | "shipping" | "portrait_history" | "portrait_history_batch";
    shop?: string;
    orderId?: string;
    orderIds?: string[];
    customerId?: string;
    action?: "approve" | "modify";
    note?: string;
    notes?: NoteInput[];
    orderName?: string;
    giftMessage?: {
      title?: string;
      sender?: string;
      recipient?: string;
      message?: string;
    } | null;
    address?: {
      fullName?: string;
      street?: string;
      city?: string;
      region?: string;
      postalCode?: string;
      country?: string;
    };
  };

  try {
    body = JSON.parse(rawBody) as typeof body;
  } catch {
    return json({ ok: false, error: "Invalid JSON body" }, 400);
  }

  const isBatch = body.type === "portrait_history_batch";
  if (!body.type || !body.customerId || (!isBatch && !body.orderId)) {
    return json(
      { ok: false, error: "type, orderId, and customerId are required" },
      400,
    );
  }

  const shop = resolveAllowedShop(body.shop);
  if (!shop) {
    return json({ ok: false, error: "Shop not allowed" }, 403);
  }

  let admin;
  try {
    ({ admin } = await unauthenticated.admin(shop));
  } catch (err) {
    console.error("[order-write] unauthenticated.admin failed", err);
    return json({ ok: false, error: "Admin session unavailable" }, 503);
  }

  if (isBatch) {
    const orderGids = [
      ...new Set((body.orderIds || []).map((id) => normalizeOrderGid(String(id)))),
    ].slice(0, MAX_BATCH_ORDERS);
    const customerGid = normalizeCustomerGid(body.customerId);
    const gates = (await fetchOrderGates(admin, orderGids)).filter(
      (gate) => gate.customerId === customerGid,
    );
    const histories = await buildPortraitHistories(
      shop,
      gates.map((gate) => ({
        shopifyOrderId: orderNumericId(gate.id),
        businessStatus: gate.businessStatus,
      })),
    );
    return json({
      ok: true,
      orders: Object.fromEntries(
        gates.map((gate) => [gate.id, histories.get(orderNumericId(gate.id))]),
      ),
    });
  }

  const orderId = String(body.orderId);
  const ownerId = normalizeOrderGid(orderId);
  const shopifyOrderId = orderNumericId(orderId);
  const customerGid = normalizeCustomerGid(body.customerId);

  const ownershipResponse = await admin.graphql(
    `#graphql
    query OrderWriteGate($id: ID!) {
      order(id: $id) {
        id
        name
        email
        cancelledAt
        closedAt
        displayFinancialStatus
        displayFulfillmentStatus
        customer { id }
        businessStatus: metafield(namespace: "custom", key: "business_status") {
          value
        }
      }
    }`,
    { variables: { id: ownerId } },
  );
  const ownershipJson = await ownershipResponse.json();
  const order = ownershipJson?.data?.order;
  if (!order?.customer?.id) {
    return json({ ok: false, error: "Order not found" }, 404);
  }
  if (order.customer.id !== customerGid) {
    return json({ ok: false, error: "Forbidden" }, 403);
  }

  const current = effectiveBusinessStatus(
    order.businessStatus?.value,
    order.displayFulfillmentStatus,
  );

  if (body.type === "portrait_history") {
    const histories = await buildPortraitHistories(shop, [
      { shopifyOrderId, businessStatus: current },
    ]);
    return json({ ok: true, ...histories.get(shopifyOrderId) });
  }

  if (body.type === "review") {
    if (body.action !== "approve" && body.action !== "modify") {
      return json({ ok: false, error: "action must be approve or modify" }, 400);
    }

    const blockReason = orderBlockReason(order);
    if (blockReason) return json({ ok: false, error: blockReason }, 409);

    let index = await getSupplierOrder(shop, shopifyOrderId);
    if (!index) {
      index = await upsertSupplierOrder({
        shop,
        shopifyOrderId,
        orderName: order.name || body.orderName || `#${shopifyOrderId}`,
        customerEmail: order.email || null,
        businessStatus: current,
      });
    }
    const progress = await loadOrderPortraitProgress(shop, shopifyOrderId, current);
    const versionCount = progress.versionCount;
    if (current === "portrait_review" && versionCount === 0) {
      return json(
        { ok: false, error: "No portrait has been uploaded for this order yet." },
        409,
      );
    }

    if (body.action === "approve") {
      const outcome = await runTransition({
        admin,
        ownerId,
        index,
        current,
        next: "prepare_shipment",
      });
      if (!outcome.ok) return json({ ok: false, error: outcome.error }, outcome.status);
      return json({ ok: true, businessStatus: "prepare_shipment", orderId: ownerId });
    }

    if (current === "portrait_review" && !canRequestModification(versionCount)) {
      return json(
        {
          ok: false,
          error:
            "Modification limit reached. Please approve the latest portrait.",
        },
        409,
      );
    }

    const notes = parseNotes(body);
    if (!notes.length) {
      return json({ ok: false, error: "At least one modification note required" }, 400);
    }

    const outcome = await runTransition({
      admin,
      ownerId,
      index,
      current,
      next: "supplier_modification",
      apply: async () => {
        await deleteStalePortraitRows(progress);
        return insertModificationRequest({
          shop,
          shopifyOrderId,
          againstVersion: versionCount,
          notes,
        });
      },
      undo: (created) => deleteModificationRequest(created.request.id),
    });
    if (!outcome.ok) return json({ ok: false, error: outcome.error }, outcome.status);

    return json({
      ok: true,
      businessStatus: "supplier_modification",
      orderId: ownerId,
      againstVersion: versionCount,
      noteCount: notes.length,
    });
  }

  const editGate = isEditable(order);
  if (!editGate.ok) {
    return json({ ok: false, error: editGate.reason || "Not editable" }, 409);
  }

  if (body.type === "gift") {
    const value = body.giftMessage
      ? JSON.stringify({
          title: (body.giftMessage.title || "").slice(0, 200),
          sender: (body.giftMessage.sender || "").slice(0, 200),
          recipient: (body.giftMessage.recipient || "").slice(0, 200),
          message: (body.giftMessage.message || "").slice(0, 2000),
        })
      : "";
    const response = await admin.graphql(
      `#graphql
      mutation SetGiftMessage($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) {
          userErrors { message field }
        }
      }`,
      {
        variables: {
          metafields: [
            {
              ownerId,
              namespace: "custom",
              key: "gift_message",
              type: "multi_line_text_field",
              value: value || " ",
            },
          ],
        },
      },
    );
    const jsonBody = await response.json();
    const errors = jsonBody.data?.metafieldsSet?.userErrors;
    if (errors?.length) {
      return json({ ok: false, error: errors[0].message }, 422);
    }
    return json({ ok: true, orderId: ownerId });
  }

  if (body.type === "shipping") {
    if (!body.address?.street || !body.address?.city) {
      return json({ ok: false, error: "address.street and city required" }, 400);
    }
    const nameParts = (body.address.fullName || "").trim().split(/\s+/);
    const firstName = nameParts[0] || "Customer";
    const lastName = nameParts.slice(1).join(" ") || "-";
    const response = await admin.graphql(
      `#graphql
      mutation UpdateOrderShipping($input: OrderInput!) {
        orderUpdate(input: $input) {
          order { id }
          userErrors { message field }
        }
      }`,
      {
        variables: {
          input: {
            id: ownerId,
            shippingAddress: {
              firstName,
              lastName,
              address1: body.address.street.slice(0, 255),
              city: body.address.city.slice(0, 100),
              province: (body.address.region || "").slice(0, 100),
              zip: (body.address.postalCode || "").slice(0, 40),
              country: (body.address.country || "").slice(0, 100),
            },
          },
        },
      },
    );
    const jsonBody = await response.json();
    const errors = jsonBody.data?.orderUpdate?.userErrors;
    if (errors?.length) {
      return json({ ok: false, error: errors[0].message }, 422);
    }
    return json({ ok: true, orderId: ownerId });
  }

  return json({ ok: false, error: "Unknown type" }, 400);
};
