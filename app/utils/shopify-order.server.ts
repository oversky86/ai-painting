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
  return normalizeBusinessStatus(await readOrderBusinessStatusValue(admin, orderGid));
}

/** Raw metafield value; null when the order has never been given a status. */
export async function readOrderBusinessStatusValue(
  admin: AdminClient,
  orderGid: string,
): Promise<string | null> {
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
  return json?.data?.order?.businessStatus?.value || null;
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

type FulfillmentOrderNode = {
  id: string;
  status: string;
  supportedActions?: Array<{ action: string }>;
  lineItems?: { nodes: Array<{ id: string; remainingQuantity: number }> };
};

const DONE_FULFILLMENT_ORDER_STATUSES = new Set(["CLOSED", "CANCELLED"]);

/**
 * Fulfills every remaining fulfillment order on the order. Fulfillment orders
 * can sit at different locations and one fulfillmentCreate call only accepts a
 * single location, so each is fulfilled separately. Safe to call again after a
 * partial failure: closed fulfillment orders are skipped.
 */
export async function createOrderFulfillment(
  admin: AdminClient,
  orderGid: string,
  tracking: { company: string; number: string },
): Promise<{ fulfilledCount: number }> {
  const foResponse = await admin.graphql(
    `#graphql
    query OrderFulfillmentOrders($id: ID!) {
      order(id: $id) {
        id
        fulfillmentOrders(first: 20) {
          nodes {
            id
            status
            supportedActions { action }
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
  const fulfillmentOrders: FulfillmentOrderNode[] =
    foJson?.data?.order?.fulfillmentOrders?.nodes || [];
  if (!fulfillmentOrders.length) {
    throw new Error("This order has no fulfillment orders");
  }

  const pending = fulfillmentOrders.filter(
    (fo) => !DONE_FULFILLMENT_ORDER_STATUSES.has(fo.status),
  );
  const blocked = pending.filter(
    (fo) =>
      !fo.supportedActions?.some((a) => a.action === "CREATE_FULFILLMENT"),
  );
  if (blocked.length) {
    throw new Error(
      `Fulfillment order is ${blocked[0].status}; release it in Shopify admin before shipping`,
    );
  }

  let fulfilledCount = 0;
  for (const fo of pending) {
    const lineItems = (fo.lineItems?.nodes || [])
      .filter((li) => (li.remainingQuantity || 0) > 0)
      .map((li) => ({ id: li.id, quantity: li.remainingQuantity }));
    if (!lineItems.length) continue;

    const response = await admin.graphql(
      `#graphql
      mutation FulfillOrder($fulfillment: FulfillmentInput!) {
        fulfillmentCreate(fulfillment: $fulfillment) {
          fulfillment { id status }
          userErrors { message field }
        }
      }`,
      {
        variables: {
          fulfillment: {
            lineItemsByFulfillmentOrder: [
              { fulfillmentOrderId: fo.id, fulfillmentOrderLineItems: lineItems },
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
    const errors = json?.data?.fulfillmentCreate?.userErrors;
    if (errors?.length) {
      throw new Error(errors[0].message || "fulfillmentCreate failed");
    }
    if (!json?.data?.fulfillmentCreate?.fulfillment) {
      throw new Error("fulfillmentCreate returned no fulfillment");
    }
    fulfilledCount += 1;
  }
  return { fulfilledCount };
}

export type CustomerOrderGate = {
  id: string;
  name: string;
  customerId: string | null;
  businessStatus: BusinessStatus;
};

/** One Admin call for many orders: ownership plus current business_status. */
export async function fetchOrderGates(
  admin: AdminClient,
  orderGids: string[],
): Promise<CustomerOrderGate[]> {
  if (!orderGids.length) return [];
  const response = await admin.graphql(
    `#graphql
    query OrderGates($ids: [ID!]!) {
      nodes(ids: $ids) {
        ... on Order {
          id
          name
          customer { id }
          businessStatus: metafield(namespace: "custom", key: "business_status") {
            value
          }
        }
      }
    }`,
    { variables: { ids: orderGids } },
  );
  const json = await response.json();
  const nodes: Array<{
    id?: string;
    name?: string;
    customer?: { id: string } | null;
    businessStatus?: { value?: string | null } | null;
  } | null> = json?.data?.nodes || [];
  return nodes.flatMap((node) =>
    node?.id
      ? [
          {
            id: node.id,
            name: node.name || "",
            customerId: node.customer?.id || null,
            businessStatus: normalizeBusinessStatus(node.businessStatus?.value),
          },
        ]
      : [],
  );
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
