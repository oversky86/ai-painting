import type { LoaderFunctionArgs } from "react-router";
import { unauthenticated } from "../shopify.server";
import { withCors, handleCorsPreflight } from "../utils/cors.server";
import {
  verifyAppProxySignature,
  getShopFromProxy,
  getCustomerIdFromProxy,
} from "../utils/app-proxy-verify";

const DEV_SHOP = "e-commerce-dev-v6yidmlw.myshopify.com";

type Money = { amount: string; currencyCode: string };

function json(data: unknown, status = 200, request?: Request) {
  return withCors(Response.json(data, { status }), request);
}

function moneyOf(set: { shopMoney?: { amount?: string | null; currencyCode?: string | null } | null } | null): Money {
  const node = set?.shopMoney;
  const amount = Number(node?.amount || 0);
  return {
    amount: (Number.isFinite(amount) ? amount : 0).toFixed(2),
    currencyCode: node?.currencyCode || "USD",
  };
}

function paidOf(total: Money, due: Money): Money {
  const paid = Math.max(0, Number(total.amount) - Number(due.amount));
  return { amount: paid.toFixed(2), currencyCode: total.currencyCode };
}

/**
 * Dev-store account page. Liquid `customer.orders` omits Bogus test orders,
 * so this proxy reads them with the Admin API for the logged-in customer only.
 */
export async function loader({ request }: LoaderFunctionArgs) {
  const preflight = handleCorsPreflight(request);
  if (preflight) return preflight;

  if (!verifyAppProxySignature(request)) {
    return json({ ok: false, error: "Unauthorized" }, 401, request);
  }

  const shop = getShopFromProxy(request);
  if (shop !== DEV_SHOP) {
    return json({ ok: false, error: "Shop not allowed" }, 403, request);
  }

  const customerId = getCustomerIdFromProxy(request);
  if (!/^\d+$/.test(customerId)) {
    return json({ ok: false, error: "Sign in required" }, 401, request);
  }

  let admin: Awaited<ReturnType<typeof unauthenticated.admin>>["admin"];
  try {
    ({ admin } = await unauthenticated.admin(shop));
  } catch (err) {
    console.error("[account-orders] admin session failed", err);
    return json({ ok: false, error: "Admin session unavailable" }, 503, request);
  }

  const customerResponse = await admin.graphql(
    `#graphql
    query AccountCustomer($id: ID!) {
      customer(id: $id) { id email }
    }`,
    { variables: { id: `gid://shopify/Customer/${customerId}` } },
  );
  const customerJson = await customerResponse.json();
  if (customerJson?.errors?.length) {
    console.error("[account-orders] customer query failed", customerJson.errors);
    return json({ ok: false, error: "Could not load orders" }, 502, request);
  }
  const customer = customerJson?.data?.customer;
  if (!customer) return json({ ok: true, orders: [] }, 200, request);
  const email = String(customer?.email || "").trim().toLowerCase();
  const safeEmail = email.replace(/["\\]/g, "");
  const search = safeEmail
    ? `customer_id:${customerId} OR email:"${safeEmail}"`
    : `customer_id:${customerId}`;

  const ordersResponse = await admin.graphql(
    `#graphql
    query AccountOrders($query: String!) {
      orders(first: 25, query: $query, sortKey: CREATED_AT, reverse: true) {
        nodes {
          name
          email
          createdAt
          test
          displayFinancialStatus
          displayFulfillmentStatus
          statusPageUrl
          customer { id }
          totalPriceSet { shopMoney { amount currencyCode } }
          totalOutstandingSet { shopMoney { amount currencyCode } }
        }
      }
    }`,
    { variables: { query: search } },
  );
  const ordersJson = await ordersResponse.json();
  if (ordersJson?.errors?.length) {
    console.error("[account-orders] query failed", ordersJson.errors);
    return json({ ok: false, error: "Could not load orders" }, 502, request);
  }

  const orders = (ordersJson?.data?.orders?.nodes || [])
    .filter((order: { email?: string | null; customer?: { id?: string | null } | null }) => {
      const orderEmail = String(order?.email || "").trim().toLowerCase();
      const orderCustomerId = String(order?.customer?.id || "").split("/").pop() || "";
      return (safeEmail && orderEmail === safeEmail) || orderCustomerId === customerId;
    })
    .map((order: {
      name?: string | null;
      createdAt?: string | null;
      test?: boolean | null;
      displayFinancialStatus?: string | null;
      displayFulfillmentStatus?: string | null;
      statusPageUrl?: string | null;
      totalPriceSet?: { shopMoney?: { amount?: string | null; currencyCode?: string | null } | null } | null;
      totalOutstandingSet?: { shopMoney?: { amount?: string | null; currencyCode?: string | null } | null } | null;
    }) => {
      const total = moneyOf(order.totalPriceSet);
      const due = moneyOf(order.totalOutstandingSet);
      return {
        name: order.name || "",
        createdAt: order.createdAt || "",
        test: Boolean(order.test),
        financialStatus: order.displayFinancialStatus || "",
        fulfillmentStatus: order.displayFulfillmentStatus || "",
        statusUrl: order.statusPageUrl || null,
        total,
        due,
        paid: paidOf(total, due),
      };
    });

  return json({ ok: true, orders }, 200, request);
}
