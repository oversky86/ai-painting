import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { upsertSupplierOrder } from "../utils/supplier-store.server";
import { readOrderBusinessStatusValue } from "../utils/shopify-order.server";
import {
  normalizeBusinessStatus,
  type BusinessStatus,
} from "../utils/business-status.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, shop, payload, admin } = await authenticate.webhook(request);

  if (topic !== "ORDERS_CREATE") {
    throw new Response("Unhandled webhook topic", { status: 404 });
  }

  const orderPayload = payload as {
    id: number;
    name?: string;
    email?: string;
    created_at?: string;
    total_price?: string;
    line_items?: Array<{
      id: number;
      properties?: Array<{ name: string; value: string }>;
    }>;
  };

  console.log(`[Webhook] Order ${orderPayload.id} received from ${shop}`);

  try {
    for (const item of orderPayload.line_items || []) {
      console.log(
        `[Webhook] Line item ${item.id} properties:`,
        JSON.stringify(item.properties || []),
      );
    }

    const customAttrs: Record<string, string> = {};
    const attrKeys = ["original_photo_url", "painting_url", "style"] as const;
    const normalizePropName = (name: string) =>
      name.startsWith("_") ? name.slice(1) : name;

    for (const item of orderPayload.line_items || []) {
      for (const prop of item.properties || []) {
        const key = normalizePropName(prop.name);
        if (
          (attrKeys as readonly string[]).includes(key) &&
          prop.value &&
          !customAttrs[key]
        ) {
          customAttrs[key] = prop.value;
        }
      }
      if (Object.keys(customAttrs).length === attrKeys.length) break;
    }

    const shopifyOrderId = String(orderPayload.id);
    const ownerId = `gid://shopify/Order/${shopifyOrderId}`;
    let businessStatus: BusinessStatus = "order_placed";

    if (admin) {
      // Shopify can redeliver orders/create; never push an advanced order back to order_placed.
      const existingStatus = await readOrderBusinessStatusValue(admin, ownerId);
      if (existingStatus) businessStatus = normalizeBusinessStatus(existingStatus);

      const metafields = [
        !existingStatus && {
          ownerId,
          namespace: "custom",
          key: "business_status",
          value: "order_placed",
          type: "single_line_text_field",
        },
        customAttrs.original_photo_url && {
          ownerId,
          namespace: "custom",
          key: "original_photo_url",
          value: customAttrs.original_photo_url,
          type: "single_line_text_field",
        },
        customAttrs.painting_url && {
          ownerId,
          namespace: "custom",
          key: "painting_url",
          value: customAttrs.painting_url,
          type: "single_line_text_field",
        },
        customAttrs.style && {
          ownerId,
          namespace: "custom",
          key: "painting_style",
          value: customAttrs.style,
          type: "single_line_text_field",
        },
      ].filter(Boolean);

      const response = await admin.graphql(
        `mutation SetOrderMetafields($metafields: [MetafieldsSetInput!]!) {
          metafieldsSet(metafields: $metafields) {
            metafields { id key namespace }
            userErrors { message field }
          }
        }`,
        { variables: { metafields } },
      );
      const json = await response.json();
      const errors = json.data?.metafieldsSet?.userErrors;
      if (errors?.length) {
        // A 5xx makes Shopify redeliver; the handler is safe to rerun (see existingStatus above).
        console.error(`[Webhook] metafieldsSet errors:`, errors);
        return new Response("metafieldsSet failed", { status: 500 });
      }
      console.log(
        `[Webhook] Order ${orderPayload.id} business_status=${businessStatus}`,
      );
    } else {
      console.error(
        "[Webhook] No admin session — cannot set metafields; still indexing",
      );
    }

    try {
      await upsertSupplierOrder({
        shop,
        shopifyOrderId,
        orderName: orderPayload.name || `#${shopifyOrderId}`,
        customerEmail: orderPayload.email || null,
        businessStatus,
        placedAt: orderPayload.created_at,
      });
    } catch (indexError) {
      console.error("[Webhook] supplier_orders upsert failed:", indexError);
    }
  } catch (error) {
    console.error("[Webhook] Order processing error:", error);
    return new Response("Order processing failed", { status: 500 });
  }

  return new Response();
};
