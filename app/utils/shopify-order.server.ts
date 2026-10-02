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

/** A fully fulfilled order is shipped, whoever fulfilled it (our ship action or Shopify admin). */
export function effectiveBusinessStatus(
  metafieldValue: string | null | undefined,
  displayFulfillmentStatus: string | null | undefined,
): BusinessStatus {
  if ((displayFulfillmentStatus || "").toUpperCase() === "FULFILLED") return "shipped";
  return normalizeBusinessStatus(metafieldValue);
}

const BLOCKED_FINANCIAL_STATUSES = new Set(["REFUNDED", "VOIDED"]);

/** Why no portrait or review work may happen on this order, or null when it may. */
export function orderBlockReason(order: {
  cancelledAt?: string | null;
  displayFinancialStatus?: string | null;
}): string | null {
  if (order.cancelledAt) return "This order was cancelled.";
  if (BLOCKED_FINANCIAL_STATUSES.has((order.displayFinancialStatus || "").toUpperCase())) {
    return "This order was refunded.";
  }
  return null;
}

export type OrderGate = {
  id: string;
  name: string;
  email: string | null;
  createdAt: string;
  customerId: string | null;
  cancelledAt: string | null;
  displayFinancialStatus: string | null;
  displayFulfillmentStatus: string | null;
  /** Raw metafield value. */
  metafieldStatus: string | null;
  businessStatus: BusinessStatus;
  blockReason: string | null;
};

/** Live order state for one order; null when Shopify doesn't return the order. */
export async function fetchOrderGate(
  admin: AdminClient,
  orderGid: string,
): Promise<OrderGate | null> {
  const response = await admin.graphql(
    `#graphql
    query OrderGate($id: ID!) {
      order(id: $id) {
        id
        name
        email
        createdAt
        cancelledAt
        displayFinancialStatus
        displayFulfillmentStatus
        customer { id }
        businessStatus: metafield(namespace: "custom", key: "business_status") {
          value
        }
      }
    }`,
    { variables: { id: orderGid } },
  );
  const json = await response.json();
  if (json?.errors?.length) {
    throw new Error(json.errors[0].message || "Failed to load Shopify order");
  }
  const order = json?.data?.order;
  if (!order?.id) return null;
  const metafieldStatus = order.businessStatus?.value || null;
  return {
    id: order.id,
    name: order.name || "",
    email: order.email || null,
    createdAt: order.createdAt,
    customerId: order.customer?.id || null,
    cancelledAt: order.cancelledAt || null,
    displayFinancialStatus: order.displayFinancialStatus || null,
    displayFulfillmentStatus: order.displayFulfillmentStatus || null,
    metafieldStatus,
    businessStatus: effectiveBusinessStatus(metafieldStatus, order.displayFulfillmentStatus),
    blockReason: orderBlockReason(order),
  };
}

/** Best-effort: brings a stale metafield in line with the effective status (e.g. fulfilled in Shopify admin). */
export async function syncBusinessStatusMetafield(
  admin: AdminClient,
  gate: Pick<OrderGate, "id" | "metafieldStatus" | "businessStatus">,
): Promise<void> {
  if (gate.metafieldStatus === gate.businessStatus) return;
  if (gate.businessStatus !== "shipped") return;
  await setOrderBusinessStatus(admin, gate.id, "shipped").catch((err) =>
    console.error("[shopify-order] status sync failed", gate.id, err),
  );
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
 * partial failure: closed fulfillment orders are skipped. Throws when nothing
 * was or could be fulfilled (for example, every fulfillment order was cancelled).
 */
export async function createOrderFulfillment(
  admin: AdminClient,
  orderGid: string,
  tracking: { company: string; number: string },
): Promise<{ fulfilledCount: number; alreadyFulfilled: boolean }> {
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
  if (fulfilledCount > 0) return { fulfilledCount, alreadyFulfilled: false };
  if (fulfillmentOrders.some((fo) => fo.status === "CLOSED")) {
    return { fulfilledCount: 0, alreadyFulfilled: true };
  }
  throw new Error("Nothing left to fulfill on this order. Check it in Shopify admin.");
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
          displayFulfillmentStatus
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
    displayFulfillmentStatus?: string | null;
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
            businessStatus: effectiveBusinessStatus(
              node.businessStatus?.value,
              node.displayFulfillmentStatus,
            ),
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

type QueueTab = "action" | "waiting" | "done";

const OPEN_WORK_QUERY =
  "-status:cancelled -fulfillment_status:fulfilled -financial_status:refunded -financial_status:voided";

/**
 * Open tabs scan unfulfilled, unrefunded orders oldest first so nothing waiting
 * drops off; the done tab shows the most recent fulfilled orders.
 */
const QUEUE_TABS: Record<
  QueueTab,
  { statuses: BusinessStatus[]; query: string; reverse: boolean; pages: number }
> = {
  action: {
    statuses: ["order_placed", "supplier_modification", "prepare_shipment"],
    query: OPEN_WORK_QUERY,
    reverse: false,
    pages: 8,
  },
  waiting: {
    statuses: ["portrait_review"],
    query: OPEN_WORK_QUERY,
    reverse: false,
    pages: 8,
  },
  done: {
    statuses: ["shipped"],
    query: "-status:cancelled fulfillment_status:fulfilled",
    reverse: true,
    pages: 2,
  },
};

/**
 * Queue rows come from Shopify orders. Status is the order metafield, or shipped once fulfilled.
 * Portrait files and modification notes are not on the order, so callers add those from the database.
 */
export async function listShopifyOrdersForSupplier(
  admin: AdminClient,
  tab: QueueTab,
): Promise<SupplierQueueOrder[]> {
  const config = QUEUE_TABS[tab] || QUEUE_TABS.action;
  const wanted = new Set(config.statuses);
  const rows: SupplierQueueOrder[] = [];
  let cursor: string | null = null;

  for (let page = 0; page < config.pages; page += 1) {
    const response = await admin.graphql(
      `#graphql
      query SupplierOrderQueue($cursor: String, $query: String, $reverse: Boolean) {
        orders(first: 50, after: $cursor, query: $query, sortKey: CREATED_AT, reverse: $reverse) {
          pageInfo { hasNextPage endCursor }
          nodes {
            id
            name
            email
            createdAt
            cancelledAt
            displayFulfillmentStatus
            businessStatus: metafield(namespace: "custom", key: "business_status") { value }
            fulfillments(first: 5) {
              trackingInfo { company number }
            }
          }
        }
      }`,
      { variables: { cursor, query: config.query, reverse: config.reverse } },
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
      displayFulfillmentStatus?: string | null;
      businessStatus?: { value?: string | null } | null;
      fulfillments?: Array<{ trackingInfo?: TrackingInfo[] | null }> | null;
    }> = connection?.nodes || [];

    for (const node of nodes) {
      if (!node?.id || node.cancelledAt) continue;
      const businessStatus = effectiveBusinessStatus(
        node.businessStatus?.value,
        node.displayFulfillmentStatus,
      );
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
    const byDate = a.placedAt.localeCompare(b.placedAt);
    return config.reverse ? -byDate : byDate;
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
        cancelledAt
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
