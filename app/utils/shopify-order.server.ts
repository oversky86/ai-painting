import type { BusinessStatus } from "./business-status.server";
import { normalizeBusinessStatus } from "./business-status.server";

type AdminClient = {
  graphql: (
    query: string,
    options?: { variables?: Record<string, unknown> },
  ) => Promise<Response>;
};

export async function getOrderBusinessStatus(
  admin: AdminClient,
  orderGid: string,
): Promise<BusinessStatus> {
  const response = await admin.graphql(
    `#graphql
    query OrderBusinessStatus($id: ID!) {
      order(id: $id) {
        id
        businessStatus: metafield(namespace: "custom", key: "business_status") {
          value
        }
      }
    }`,
    { variables: { id: orderGid } },
  );
  const json = await response.json();
  return normalizeBusinessStatus(json?.data?.order?.businessStatus?.value);
}

export async function setOrderBusinessStatus(
  admin: AdminClient,
  orderGid: string,
  status: BusinessStatus,
): Promise<void> {
  const response = await admin.graphql(
    `#graphql
    mutation SetBusinessStatus($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        userErrors { message field }
      }
    }`,
    {
      variables: {
        metafields: [
          {
            ownerId: orderGid,
            namespace: "custom",
            key: "business_status",
            type: "single_line_text_field",
            value: status,
          },
        ],
      },
    },
  );
  const json = await response.json();
  const errors = json?.data?.metafieldsSet?.userErrors;
  if (errors?.length) {
    throw new Error(errors[0].message || "Failed to set business_status");
  }
}

export async function enableBusinessStatusCustomerRead(
  admin: AdminClient,
): Promise<{ ok: boolean; message: string }> {
  const find = await admin.graphql(
    `#graphql
    query FindBusinessStatusDef {
      metafieldDefinitions(
        first: 20
        ownerType: ORDER
        namespace: "custom"
        key: "business_status"
      ) {
        nodes { id name namespace key }
      }
    }`,
  );
  const findJson = await find.json();
  const def = findJson?.data?.metafieldDefinitions?.nodes?.[0];
  if (!def?.id) {
    return {
      ok: false,
      message: "custom.business_status definition not found on this shop",
    };
  }

  const update = await admin.graphql(
    `#graphql
    mutation EnableCustomerRead($definition: MetafieldDefinitionUpdateInput!) {
      metafieldDefinitionUpdate(definition: $definition) {
        updatedDefinition { id }
        userErrors { message field }
      }
    }`,
    {
      variables: {
        definition: {
          id: def.id,
          access: {
            customerAccount: "READ",
            admin: "MERCHANT_READ_WRITE",
          },
        },
      },
    },
  );
  const updateJson = await update.json();
  const errors = updateJson?.data?.metafieldDefinitionUpdate?.userErrors;
  if (errors?.length) {
    return { ok: false, message: errors[0].message };
  }
  return { ok: true, message: "customerAccount READ enabled" };
}

export async function createOrderFulfillment(
  admin: AdminClient,
  orderGid: string,
  tracking: { company: string; number: string },
): Promise<void> {
  const foResponse = await admin.graphql(
    `#graphql
    query OrderFulfillmentOrders($id: ID!) {
      order(id: $id) {
        id
        fulfillmentOrders(first: 10) {
          nodes {
            id
            status
            lineItems(first: 50) {
              nodes { id remainingQuantity }
            }
          }
        }
      }
    }`,
    { variables: { id: orderGid } },
  );
  const foJson = await foResponse.json();
  const fulfillmentOrders =
    foJson?.data?.order?.fulfillmentOrders?.nodes || [];
  const open = fulfillmentOrders.find(
    (fo: { status?: string }) =>
      fo.status === "OPEN" || fo.status === "IN_PROGRESS",
  );
  if (!open?.id) {
    throw new Error("No open fulfillment order available");
  }

  const lineItems = (open.lineItems?.nodes || [])
    .filter((li: { remainingQuantity?: number }) => (li.remainingQuantity || 0) > 0)
    .map((li: { id: string; remainingQuantity: number }) => ({
      id: li.id,
      quantity: li.remainingQuantity,
    }));

  if (!lineItems.length) {
    throw new Error("No remaining line items to fulfill");
  }

  const response = await admin.graphql(
    `#graphql
    mutation FulfillOrder($fulfillment: FulfillmentV2Input!) {
      fulfillmentCreateV2(fulfillment: $fulfillment) {
        fulfillment { id status }
        userErrors { message field }
      }
    }`,
    {
      variables: {
        fulfillment: {
          lineItemsByFulfillmentOrder: [
            {
              fulfillmentOrderId: open.id,
              fulfillmentOrderLineItems: lineItems,
            },
          ],
          trackingInfo: {
            company: tracking.company.slice(0, 100),
            number: tracking.number.slice(0, 100),
          },
          notifyCustomer: true,
        },
      },
    },
  );
  const json = await response.json();
  const errors = json?.data?.fulfillmentCreateV2?.userErrors;
  if (errors?.length) {
    throw new Error(errors[0].message || "fulfillmentCreateV2 failed");
  }
}

export async function fetchOrderDetailForSupplier(
  admin: AdminClient,
  orderGid: string,
) {
  const response = await admin.graphql(
    `#graphql
    query SupplierOrderDetail($id: ID!) {
      order(id: $id) {
        id
        name
        email
        createdAt
        displayFinancialStatus
        displayFulfillmentStatus
        totalPriceSet { shopMoney { amount currencyCode } }
        shippingAddress {
          name firstName lastName address1 address2 city province zip country phone
        }
        lineItems(first: 20) {
          nodes {
            title
            variantTitle
            quantity
            customAttributes { key value }
          }
        }
        businessStatus: metafield(namespace: "custom", key: "business_status") {
          value
        }
        originalPhoto: metafield(namespace: "custom", key: "original_photo_url") {
          value
        }
        paintingUrl: metafield(namespace: "custom", key: "painting_url") {
          value
        }
        paintingStyle: metafield(namespace: "custom", key: "painting_style") {
          value
        }
        giftMessage: metafield(namespace: "custom", key: "gift_message") {
          value
        }
      }
    }`,
    { variables: { id: orderGid } },
  );
  const json = await response.json();
  return json?.data?.order || null;
}
