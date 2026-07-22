/**
 * App Proxy HMAC signature verification.
 * Shopify signs every App Proxy request with HMAC-SHA256 using the app secret.
 * This verifies the request genuinely came through Shopify's proxy.
 */
import crypto from "crypto";

export function verifyAppProxySignature(request: Request): boolean {
  const apiSecret = process.env.SHOPIFY_API_SECRET || "";
  if (!apiSecret) {
    console.error("[app-proxy] SHOPIFY_API_SECRET not set");
    return false;
  }

  const url = new URL(request.url);
  const params = new URLSearchParams(url.searchParams);
  const signature = params.get("signature");

  if (!signature) {
    console.warn("[app-proxy] No signature in request");
    return false;
  }

  // Remove signature before computing HMAC
  params.delete("signature");

  // Sort params alphabetically and build query string
  const sortedKeys = Array.from(params.keys()).sort();
  const message = sortedKeys
    .map((key) => {
      const values = params.getAll(key);
      return `${key}=${values.join(",")}`;
    })
    .join("");

  const computedSignature = crypto
    .createHmac("sha256", apiSecret)
    .update(message)
    .digest("hex");

  try {
    // Use timingSafeEqual to prevent timing attacks
    const sigBuffer = Buffer.from(signature, "hex");
    const computedBuffer = Buffer.from(computedSignature, "hex");
    if (sigBuffer.length !== computedBuffer.length) return false;
    return crypto.timingSafeEqual(sigBuffer, computedBuffer);
  } catch {
    return false;
  }
}

/**
 * Extract shop domain from App Proxy query params.
 */
export function getShopFromProxy(request: Request): string {
  const url = new URL(request.url);
  return url.searchParams.get("shop") || "unknown";
}

/**
 * Extract logged-in customer ID from App Proxy query params.
 * Returns empty string if customer is not logged in.
 */
export function getCustomerIdFromProxy(request: Request): string {
  const url = new URL(request.url);
  return url.searchParams.get("logged_in_customer_id") || "";
}
