import { createHmac, timingSafeEqual } from "node:crypto";
import { canonicalShop, DEV_SHOP, LIVE_SHOP } from "./shops.server";
import { normalizeBusinessStatus, type BusinessStatus } from "./business-status.server";
import { effectiveBusinessStatus, trackingFromFulfillments } from "./shopify-order.server";
import { buildPortraitHistories, type PortraitHistory } from "./portrait-history.server";
import { orderNumericId } from "./hmac-auth.server";
import { unauthenticated } from "../shopify.server";

const PURPOSE = "order_link";
const SEVEN_DAYS_SEC = 7 * 24 * 60 * 60;

export type OrderLinkClaims = {
  shop: string;
  orderId: string;
  customerId: string;
  purpose: typeof PURPOSE;
  version: number;
  exp: number;
};

type AdminClient = {
  graphql: (
    query: string,
    options?: { variables?: Record<string, unknown> },
  ) => Promise<Response>;
};

function linkSecret(): string {
  return (process.env.ORDER_LINK_SECRET || process.env.ACCOUNT_HMAC_SECRET || "").trim();
}

function flowSecrets(): string[] {
  return [
    ...(process.env.SHOPIFY_API_SECRETS || "").split(","),
    process.env.SHOPIFY_API_SECRET || "",
    process.env.SHOPIFY_API_SECRET_LIVE || "",
  ]
    .map((value) => value.trim())
    .filter((value, index, all) => value && all.indexOf(value) === index);
}

function b64url(value: Buffer | string): string {
  return Buffer.from(value).toString("base64url");
}

function canonicalClaims(claims: OrderLinkClaims): string {
  return JSON.stringify({
    shop: claims.shop,
    orderId: claims.orderId,
    customerId: claims.customerId,
    purpose: PURPOSE,
    version: claims.version,
    exp: claims.exp,
  });
}

export function signOrderLink(claims: Omit<OrderLinkClaims, "purpose">): string {
  const secret = linkSecret();
  if (!secret) throw new Error("ORDER_LINK_SECRET / ACCOUNT_HMAC_SECRET not configured");
  const full: OrderLinkClaims = { ...claims, purpose: PURPOSE };
  const body = b64url(canonicalClaims(full));
  const signature = createHmac("sha256", secret).update(body).digest();
  return `${body}.${b64url(signature)}`;
}

export function readOrderLink(token: string): OrderLinkClaims | null {
  const secret = linkSecret();
  if (!secret) return null;
  const [body, signature] = token.split(".");
  if (!body || !signature) return null;
  const expected = createHmac("sha256", secret).update(body).digest();
  const actual = Buffer.from(signature, "base64url");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as OrderLinkClaims;
    if (parsed.purpose !== PURPOSE) return null;
    if (!parsed.shop || !parsed.orderId || !parsed.customerId) return null;
    if (!Number.isFinite(parsed.exp) || parsed.exp * 1000 <= Date.now()) return null;
    if (!Number.isInteger(parsed.version) || parsed.version < 0) return null;
    const shop = canonicalShop(parsed.shop);
    if (shop !== DEV_SHOP && shop !== LIVE_SHOP) return null;
    return { ...parsed, shop, purpose: PURPOSE };
  } catch {
    return null;
  }
}

export function verifyShopifyFlowHmac(rawBody: string, header: string | null): boolean {
  if (!header) return false;
  let actual: Buffer;
  try {
    actual = Buffer.from(header, "base64");
  } catch {
    return false;
  }
  for (const secret of flowSecrets()) {
    const expected = createHmac("sha256", secret).update(rawBody, "utf8").digest();
    if (actual.length === expected.length && timingSafeEqual(actual, expected)) return true;
  }
  return false;
}

export function publicShopKey(shop: string): "prod" | "dev" {
  return canonicalShop(shop) === LIVE_SHOP ? "prod" : "dev";
}

export function orderLinkUrl(claims: Omit<OrderLinkClaims, "purpose">): string {
  const base = (process.env.ACCOUNT_WEB_URL || "https://orders.viewbrush.com").replace(/\/$/, "");
  const url = new URL(`${base}/orders`);
  url.searchParams.set("shop", publicShopKey(claims.shop));
  url.searchParams.set("order", claims.orderId);
  url.searchParams.set("token", signOrderLink(claims));
  return url.toString();
}

export type OrderLinkSnapshot = {
  id: string;
  name: string;
  createdAt: string;
  email: string | null;
  customerId: string;
  firstName: string | null;
  lastName: string | null;
  financialStatus: string | null;
  fulfillmentStatus: string | null;
  cancelledAt: string | null;
  total: { amount: string; currencyCode: string } | null;
  shippingAddress: {
    firstName?: string | null;
    lastName?: string | null;
    address1?: string | null;
    address2?: string | null;
    city?: string | null;
    province?: string | null;
    zip?: string | null;
    country?: string | null;
  } | null;
  tracking: { company: string | null; number: string | null } | null;
  originalPhotoUrl: string | null;
  paintingUrl: string | null;
  paintingStyle: string | null;
  businessStatus: BusinessStatus;
  versionCount: number;
  history: PortraitHistory;
};

function nonempty(value?: string | null): string | null {
  const trimmed = value?.trim();
  return trimmed || null;
}

function lineProperty(
  lines: Array<{ customAttributes?: Array<{ key?: string | null; value?: string | null }> | null }>,
  key: string,
): string | null {
  for (const line of lines) {
    for (const attr of line.customAttributes || []) {
      if (attr.key === key) return nonempty(attr.value);
    }
  }
  return null;
}

export async function loadOrderLinkSnapshot(
  admin: AdminClient,
  shop: string,
  orderGid: string,
): Promise<{ snapshot: OrderLinkSnapshot; version: number } | null> {
  const response = await admin.graphql(
    `#graphql
    query OrderLinkSnapshot($id: ID!) {
      order(id: $id) {
        id
        name
        email
        createdAt
        cancelledAt
        displayFinancialStatus
        displayFulfillmentStatus
        customer { id firstName lastName }
        totalPriceSet { shopMoney { amount currencyCode } }
        shippingAddress { firstName lastName address1 address2 city province zip country }
        lineItems(first: 10) {
          nodes { customAttributes { key value } }
        }
        businessStatus: metafield(namespace: "custom", key: "business_status") { value }
        originalPhoto: metafield(namespace: "custom", key: "original_photo_url") { value }
        paintingUrl: metafield(namespace: "custom", key: "painting_url") { value }
        paintingStyle: metafield(namespace: "custom", key: "painting_style") { value }
        fulfillments(first: 5) { trackingInfo { company number } }
      }
    }`,
    { variables: { id: orderGid } },
  );
  const json = await response.json();
  const order = json?.data?.order;
  if (!order?.id || !order.customer?.id) return null;
  const businessStatus = effectiveBusinessStatus(
    order.businessStatus?.value,
    order.displayFulfillmentStatus,
  );
  const shopifyOrderId = orderNumericId(order.id);
  const histories = await buildPortraitHistories(shop, [
    { shopifyOrderId, businessStatus },
  ]);
  const history = histories.get(shopifyOrderId);
  const version = history?.versionCount ?? 0;
  const lines = order.lineItems?.nodes || [];
  const snapshot: OrderLinkSnapshot = {
    id: order.id,
    name: order.name || "",
    createdAt: order.createdAt,
    email: order.email || null,
    customerId: order.customer.id,
    firstName: order.customer.firstName || null,
    lastName: order.customer.lastName || null,
    financialStatus: order.displayFinancialStatus || null,
    fulfillmentStatus: order.displayFulfillmentStatus || null,
    cancelledAt: order.cancelledAt || null,
    total: order.totalPriceSet?.shopMoney || null,
    shippingAddress: order.shippingAddress || null,
    tracking: trackingFromFulfillments(order.fulfillments),
    originalPhotoUrl:
      nonempty(order.originalPhoto?.value) || lineProperty(lines, "original_photo_url"),
    paintingUrl:
      nonempty(order.paintingUrl?.value) ||
      lineProperty(lines, "painting_url") ||
      lineProperty(lines, "source_painting_url"),
    paintingStyle: nonempty(order.paintingStyle?.value) || lineProperty(lines, "style"),
    businessStatus: normalizeBusinessStatus(businessStatus),
    versionCount: version,
    history: history || {
      businessStatus,
      versionCount: version,
      modificationCount: 0,
      versions: [],
      modificationRequests: [],
    },
  };
  return { snapshot, version };
}

export async function adminForOrderLink(shop: string) {
  return unauthenticated.admin(shop);
}
