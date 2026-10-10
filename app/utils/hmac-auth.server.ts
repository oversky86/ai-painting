import { createHmac, timingSafeEqual } from "node:crypto";
import { canonicalShop, DEV_SHOP, isRetiredShop, LIVE_SHOP } from "./shops.server";

const MAX_SKEW_SEC = 300;

export function verifyHmac(
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

export function assertAccountHmac(
  request: Request,
  rawBody: string,
): { ok: true } | { ok: false; status: number; error: string } {
  const secret = process.env.ACCOUNT_HMAC_SECRET;
  if (!secret) {
    return { ok: false, status: 503, error: "ACCOUNT_HMAC_SECRET not configured" };
  }

  const timestamp = request.headers.get("X-Account-Timestamp") || "";
  const signature = request.headers.get("X-Account-Signature") || "";
  const ts = Number(timestamp);

  if (
    !timestamp ||
    !signature ||
    !Number.isFinite(ts) ||
    Math.abs(Math.floor(Date.now() / 1000) - ts) > MAX_SKEW_SEC
  ) {
    return { ok: false, status: 401, error: "Invalid or expired signature" };
  }

  if (!verifyHmac(timestamp, rawBody, signature, secret)) {
    return { ok: false, status: 401, error: "Invalid signature" };
  }

  return { ok: true };
}

export function assertSupplierHmac(
  request: Request,
  rawBody: string,
): { ok: true } | { ok: false; status: number; error: string } {
  const secret =
    process.env.SUPPLIER_HMAC_SECRET || process.env.ACCOUNT_HMAC_SECRET;
  if (!secret) {
    return {
      ok: false,
      status: 503,
      error: "SUPPLIER_HMAC_SECRET / ACCOUNT_HMAC_SECRET not configured",
    };
  }

  const timestamp = request.headers.get("X-Supplier-Timestamp") || "";
  const signature = request.headers.get("X-Supplier-Signature") || "";
  const ts = Number(timestamp);

  if (
    !timestamp ||
    !signature ||
    !Number.isFinite(ts) ||
    Math.abs(Math.floor(Date.now() / 1000) - ts) > MAX_SKEW_SEC
  ) {
    return { ok: false, status: 401, error: "Invalid or expired signature" };
  }

  if (!verifyHmac(timestamp, rawBody, signature, secret)) {
    return { ok: false, status: 401, error: "Invalid signature" };
  }

  return { ok: true };
}

export function allowedWriteShops(): string[] {
  const fromEnv = (
    process.env.ACCOUNT_WRITE_SHOPS ||
    process.env.ACCOUNT_WRITE_SHOP ||
    process.env.SHOP_CUSTOM_DOMAIN ||
    process.env.SHOPIFY_SHOP ||
    ""
  )
    .split(",")
    .map((s) => canonicalShop(s))
    .filter((s) => s && !isRetiredShop(s));
  return [...new Set([DEV_SHOP, LIVE_SHOP, ...fromEnv])];
}

export function resolveAllowedShop(requested?: string | null): string | null {
  const shops = allowedWriteShops();
  if (!shops.length) return null;
  const normalized = canonicalShop(requested || "");
  if (!normalized || normalized === "unknown") return shops[0];
  if (isRetiredShop(normalized)) return null;
  return shops.find((s) => s === normalized) || null;
}

export function normalizeOrderGid(orderId: string): string {
  if (orderId.startsWith("gid://")) return orderId;
  return `gid://shopify/Order/${orderId}`;
}

export function normalizeCustomerGid(id: string): string {
  if (id.startsWith("gid://")) return id;
  return `gid://shopify/Customer/${id}`;
}

export function orderNumericId(orderId: string): string {
  if (orderId.startsWith("gid://")) {
    return orderId.split("/").pop() || orderId;
  }
  return orderId;
}
