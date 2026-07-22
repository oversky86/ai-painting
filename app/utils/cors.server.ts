/**
 * CORS utility for App API routes.
 * App Proxy: requests come from the same Shopify domain.
 * Keep restrictive origins as security fallback.
 */

const ALLOWED_ORIGINS = [
  "https://pet-paiting-frontend.vercel.app",
  "https://e-commerce-dev-v6yidmlw.myshopify.com",
  "https://w4yzmt-vv.myshopify.com",
  "http://localhost:3000",
];

function isAllowedOrigin(origin: string | null): boolean {
  if (!origin) return true; // Allow no-origin (same-origin, server-to-server)
  return ALLOWED_ORIGINS.some((o) => origin.startsWith(o));
}

/**
 * Wrap a Response with CORS headers.
 * App Proxy makes requests same-origin, but we keep this as a safety net.
 */
export function withCors(response: Response): Response {
  const origin = response.headers.get("X-Request-Origin") || "*";
  response.headers.set("Access-Control-Allow-Origin", isAllowedOrigin(origin) ? origin : "same-origin");
  response.headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  response.headers.set("Access-Control-Allow-Headers", "Content-Type, X-Shop-Domain, X-Requested-With");
  response.headers.set("Access-Control-Max-Age", "86400");
  return response;
}

/**
 * Handle OPTIONS preflight request.
 * Returns a 204 response with CORS headers, or null if not OPTIONS.
 */
export function handleCorsPreflight(request: Request): Response | null {
  if (request.method !== "OPTIONS") return null;
  return withCors(new Response(null, { status: 204 }));
}
