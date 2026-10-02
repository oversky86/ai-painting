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

export type SupplierQueueOrder = {
  id: string;
  orderName: string;
  email: string | null;
  businessStatus: BusinessStatus;
  placedAt: string;
  trackingCompany: string | null;
  trackingNumber: string | null;
};

type TrackingInfo = { company?: string | null; number?: string | null };

export function trackingFromFulfillments(
  fulfillments: Array<{ trackingInfo?: TrackingInfo[] | null }> | null | undefined,
): { company: string | null; number: string | null } {
  for (const fulfillment of fulfillments || []) {
    const info = (fulfillment.trackingInfo || []).find((item) => item.company || item.number);
    if (info) return { company: info.company || null, number: info.number || null };
  }
  return { company: null, number: null };
}

const QUEUE_STATUSES: Record<"action" | "waiting" | "done", BusinessStatus[]> = {
  action: ["order_placed", "supplier_modification", "prepare_shipment"],
  waiting: ["portrait_review"],
  done: ["shipped"],
};

/**
 * Queue rows come from Shopify orders. Status is the order metafield.
 * Portrait files and modification notes are not on the order, so callers add those from the database.
 */
export async function listShopifyOrdersForSupplier(
  admin: AdminClient,
  tab: "action" | "waiting" | "done",
): Promise<SupplierQueueOrder[]> {
  const wanted = new Set(QUEUE_STATUSES[tab] || QUEUE_STATUSES.action);
  const rows: SupplierQueueOrder[] = [];
  let cursor: string | null = null;

  for (let page = 0; page < 8; page += 1) {
    const response = await admin.graphql(
      `#graphql
      query SupplierOrderQueue($cursor: String, $query: String) {
        orders(first: 50, after: $cursor, query: $query, sortKey: CREATED_AT) {
          pageInfo { hasNextPage endCursor }
          nodes {
            id
            name
            email
            createdAt
            cancelledAt
            businessStatus: metafield(namespace: "custom", key: "business_status") { value }
            fulfillments(first: 5) {
              trackingInfo { company number }
            }
          }
        }
      }`,
      { variables: { cursor, query: "-status:cancelled" } },
    );
    const json = await response.json();
    if (json?.errors?.length) {
      throw new Error(json.errors[0].message || "Failed to list Shopify orders");
    }
    const connection = json?.data?.orders;
    const nodes: Array<{
      id: string;
      name?: string | null;
      email?: string | null;
      createdAt: string;
      cancelledAt?: string | null;
      businessStatus?: { value?: string | null } | null;
      fulfillments?: Array<{ trackingInfo?: TrackingInfo[] | null }> | null;
    }> = connection?.nodes || [];

    for (const node of nodes) {
      if (!node?.id || node.cancelledAt) continue;
      const businessStatus = normalizeBusinessStatus(node.businessStatus?.value);
      if (!wanted.has(businessStatus)) continue;
      const tracking = trackingFromFulfillments(node.fulfillments);
      rows.push({
        id: node.id.split("/").pop() || node.id,
        orderName: node.name || "",
        email: node.email || null,
        businessStatus,
        placedAt: node.createdAt,
        trackingCompany: tracking.company,
        trackingNumber: tracking.number,
      });
    }

    if (!connection?.pageInfo?.hasNextPage) break;
    cursor = connection.pageInfo.endCursor || null;
  }

  const priority: Record<string, number> = {
    supplier_modification: 0,
    prepare_shipment: 1,
    order_placed: 2,
    portrait_review: 3,
    shipped: 4,
  };
  return rows.sort((a, b) => {
    const diff = (priority[a.businessStatus] ?? 9) - (priority[b.businessStatus] ?? 9);
    if (diff !== 0) return diff;
    return a.placedAt.localeCompare(b.placedAt);
  });
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
        fulfillments(first: 5) {
          trackingInfo { company number }
        }
      }
    }`,
    { variables: { id: orderGid } },
  );
  const json = await response.json();
  return json?.data?.order || null;
}
