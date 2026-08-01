/**
 * App Proxy HMAC signature verification.
 * Shopify signs every App Proxy request with HMAC-SHA256 using the app secret.
 * This verifies the request genuinely came through Shopify's proxy.
 *
 * Supports multiple app secrets (SHOPIFY_API_SECRETS=secret1,secret2) so that
 * multiple Shopify apps can share the same backend.
 */
import crypto from "crypto";

/** All valid API secrets — supports multi-app setups via comma-separated SHOPIFY_API_SECRETS */
const SECRETS: string[] = (
  process.env.SHOPIFY_API_SECRETS || process.env.SHOPIFY_API_SECRET || ""
)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

export function verifyAppProxySignature(request: Request): boolean {
  if (SECRETS.length === 0) {
    console.error("[app-proxy] No API secrets configured (SHOPIFY_API_SECRETS or SHOPIFY_API_SECRET)");
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

  console.log("[app-proxy] Secrets count:", SECRETS.length, "secrets:", SECRETS.map(s => s.slice(0, 8) + "..."));
  console.log("[app-proxy] Message:", message);
  console.log("[app-proxy] Signature:", signature);

  const sigBuffer = Buffer.from(signature, "hex");

  // Try each secret — return true if any matches
  for (const secret of SECRETS) {
    try {
      const computed = crypto
        .createHmac("sha256", secret)
        .update(message)
        .digest("hex");

      console.log("[app-proxy] Computed HMAC (secret", secret.slice(0, 8) + "...):", computed);

      const computedBuffer = Buffer.from(computed, "hex");
      if (sigBuffer.length === computedBuffer.length &&
          crypto.timingSafeEqual(sigBuffer, computedBuffer)) {
        console.log("[app-proxy] HMAC match!");
        return true;
      }
    } catch (e) {
      console.warn("[app-proxy] HMAC comparison error:", e);
    }
  }

  console.warn("[app-proxy] Signature did not match any configured secret");
  return false;
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
