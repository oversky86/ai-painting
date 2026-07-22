import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, shop, payload, admin } = await authenticate.webhook(request);

  if (topic !== "ORDERS_CREATE") {
    throw new Response("Unhandled webhook topic", { status: 404 });
  }

  const orderPayload = payload as {
    id: number;
    email?: string;
    total_price?: string;
    line_items?: Array<{
      id: number;
      properties?: Array<{ name: string; value: string }>;
    }>;
  };

  console.log(`[Webhook] Order ${orderPayload.id} received from ${shop}`);
  console.log(`[Webhook] admin available: ${!!admin}`);

  try {
    // Log all line item properties for debugging
    for (const item of orderPayload.line_items || []) {
      console.log(`[Webhook] Line item ${item.id} properties:`, JSON.stringify(item.properties || []));
    }

    // Extract custom painting attributes from line item properties
    const customAttrs: Record<string, string> = {};
    const attrKeys = ["original_photo_url", "painting_url", "style"];

    for (const item of orderPayload.line_items || []) {
      for (const prop of item.properties || []) {
        if (attrKeys.includes(prop.name) && prop.value) {
          customAttrs[prop.name] = prop.value;
        }
      }
      if (Object.keys(customAttrs).length === attrKeys.length) break;
    }

    console.log(`[Webhook] Extracted custom attrs:`, JSON.stringify(customAttrs));

    if (!admin) {
      console.error("[Webhook] No admin session available — cannot set metafields");
      return new Response();
    }

    // Set order metafields via Admin API if custom attributes exist
    if (Object.keys(customAttrs).length > 0) {
      const metafields = [
        customAttrs.original_photo_url && {
          namespace: "custom",
          key: "original_photo_url",
          value: customAttrs.original_photo_url,
          type: "single_line_text_field",
          access: "MERCHANT_READ",
        },
        customAttrs.painting_url && {
          namespace: "custom",
          key: "painting_url",
          value: customAttrs.painting_url,
          type: "single_line_text_field",
          access: "MERCHANT_READ",
        },
        customAttrs.style && {
          namespace: "custom",
          key: "painting_style",
          value: customAttrs.style,
          type: "single_line_text_field",
          access: "MERCHANT_READ",
        },
      ].filter(Boolean);

      if (metafields.length > 0) {
        const ownerId = `gid://shopify/Order/${orderPayload.id}`;
        const variables = {
          ownerId,
          metafields: metafields.map((mf) => ({ ...mf, ownerId })),
        };

        console.log(`[Webhook] Setting ${metafields.length} metafields for order ${orderPayload.id}`);

        const response = await admin.graphql(
          `mutation SetOrderMetafields($metafields: [MetafieldsSetInput!]!) {
            metafieldsSet(metafields: $metafields) {
              metafields { id key namespace }
              userErrors { message field }
            }
          }`,
          { variables }
        );

        const json = await response.json();
        console.log(`[Webhook] GraphQL response:`, JSON.stringify(json));

        const errors = json.data?.metafieldsSet?.userErrors;
        if (errors?.length) {
          console.error(`[Webhook] metafieldsSet errors:`, errors);
        } else {
          console.log(`[Webhook] Successfully set ${metafields.length} metafields for order ${orderPayload.id}`);
        }
      }
    } else {
      console.log(`[Webhook] No custom attributes found in order ${orderPayload.id} — skipping metafields`);
    }
  } catch (error) {
    console.error("[Webhook] Order processing error:", error);
  }

  return new Response();
};
