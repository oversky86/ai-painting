import { createHmac, timingSafeEqual } from "node:crypto";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { unauthenticated } from "../shopify.server";

/**
 * Server-to-server write API for account-web (HMAC).
 * Actions: review | gift | shipping
 */

const MAX_SKEW_SEC = 300;

function json(data: unknown, status = 200) {
  return Response.json(data, { status });
}

function normalizeOrderGid(orderId: string): string {
  if (orderId.startsWith("gid://")) return orderId;
  return `gid://shopify/Order/${orderId}`;
}

function normalizeCustomerGid(id: string): string {
  if (id.startsWith("gid://")) return id;
  return `gid://shopify/Customer/${id}`;
}

function verifyHmac(
  timestamp: string,
  rawBody: string,
  signature: string,
  secret: string,
): boolean {
  const expected = createHmac("sha256", secret)
    .update(`${timestamp}.${rawBody}`)
    .digest("hex");
  try {
    return timingSafeEqual(
      Buffer.from(expected, "hex"),
      Buffer.from(signature, "hex"),
    );
  } catch {
    return false;
  }
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

export const loader = async (_args: LoaderFunctionArgs) => {
  return json({ ok: true });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return json({ ok: false, error: "Method not allowed" }, 405);
  }

  const secret = process.env.ACCOUNT_HMAC_SECRET;
  const writeShops = (
    process.env.ACCOUNT_WRITE_SHOPS ||
    process.env.ACCOUNT_WRITE_SHOP ||
    process.env.SHOP_CUSTOM_DOMAIN ||
    process.env.SHOPIFY_SHOP ||
    ""
  )
    .split(",")
    .map((s) => s.trim().replace(/^https?:\/\//, "").replace(/\/$/, "").toLowerCase())
    .filter(Boolean);

  if (!secret) {
    return json({ ok: false, error: "ACCOUNT_HMAC_SECRET not configured" }, 503);
  }
  if (!writeShops.length) {
    return json(
      {
        ok: false,
        error:
          "Shop domain not configured (ACCOUNT_WRITE_SHOPS / ACCOUNT_WRITE_SHOP)",
      },
      503,
    );
  }

  const timestamp = request.headers.get("X-Account-Timestamp") || "";
  const signature = request.headers.get("X-Account-Signature") || "";
  const rawBody = await request.text();

  const ts = Number(timestamp);
  if (
    !timestamp ||
    !signature ||
    !Number.isFinite(ts) ||
    Math.abs(Math.floor(Date.now() / 1000) - ts) > MAX_SKEW_SEC
  ) {
    return json({ ok: false, error: "Invalid or expired signature" }, 401);
  }

  if (!verifyHmac(timestamp, rawBody, signature, secret)) {
    return json({ ok: false, error: "Invalid signature" }, 401);
  }

  let body: {
    type?: "review" | "gift" | "shipping";
    shop?: string;
    orderId?: string;
    customerId?: string;
    action?: "approve" | "modify";
    note?: string;
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

  if (!body.type || !body.orderId || !body.customerId) {
    return json(
      { ok: false, error: "type, orderId, and customerId are required" },
      400,
    );
  }

  const requestedShop = (body.shop || "")
    .trim()
    .replace(/^https?:\/\//, "")
    .replace(/\/$/, "")
    .toLowerCase();
  const shop = requestedShop
    ? writeShops.find((s) => s === requestedShop)
    : writeShops[0];
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

  const ownerId = normalizeOrderGid(body.orderId);
  const customerGid = normalizeCustomerGid(body.customerId);

  const ownershipResponse = await admin.graphql(
    `#graphql
    query OrderWriteGate($id: ID!) {
      order(id: $id) {
        id
        cancelledAt
        closedAt
        displayFulfillmentStatus
        customer { id }
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

  if (body.type === "review") {
    if (body.action !== "approve" && body.action !== "modify") {
      return json({ ok: false, error: "action must be approve or modify" }, 400);
    }
    const reviewStatus =
      body.action === "approve" ? "approved" : "modify_requested";
    const reviewNote =
      body.action === "modify" ? (body.note || "").slice(0, 2000) : "";
    const updatedAt = new Date().toISOString();
    const metafields: Array<{
      ownerId: string;
      namespace: string;
      key: string;
      type: string;
      value: string;
    }> = [
      {
        ownerId,
        namespace: "custom",
        key: "review_status",
        type: "single_line_text_field",
        value: reviewStatus,
      },
      {
        ownerId,
        namespace: "custom",
        key: "review_updated_at",
        type: "single_line_text_field",
        value: updatedAt,
      },
    ];
    if (body.action === "modify" && reviewNote) {
      metafields.push({
        ownerId,
        namespace: "custom",
        key: "review_note",
        type: "multi_line_text_field",
        value: reviewNote,
      });
    }
    const response = await admin.graphql(
      `#graphql
      mutation SetReviewMetafields($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) {
          userErrors { message field }
        }
      }`,
      { variables: { metafields } },
    );
    const jsonBody = await response.json();
    const errors = jsonBody.data?.metafieldsSet?.userErrors;
    if (errors?.length) {
      return json({ ok: false, error: errors[0].message }, 422);
    }
    return json({ ok: true, reviewStatus, orderId: ownerId, updatedAt });
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
