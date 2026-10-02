/**
 * CORS utility for App API routes.
 * Supports both App Proxy (same-origin via Shopify proxy) and direct cross-origin calls.
 */

const ALLOWED_ORIGINS = [
  "https://pet-paiting-frontend.vercel.app",
  "https://e-commerce-dev-v6yidmlw.myshopify.com",
  "http://localhost:3000",
  "http://localhost:3001",
];

function isAllowedOrigin(origin: string): boolean {
  return ALLOWED_ORIGINS.some((o) => origin.startsWith(o));
}

/**
 * Wrap a Response with CORS headers.
 * @param response - The response to add CORS headers to
 * @param request  - Optional request object to read the real Origin header
 */
export function withCors(response: Response, request?: Request): Response {
  const origin = request?.headers.get("Origin") || null;
  if (origin && isAllowedOrigin(origin)) {
    response.headers.set("Access-Control-Allow-Origin", origin);
  } else if (!origin) {
    // No Origin header (server-to-server or same-origin App Proxy) — allow all
    response.headers.set("Access-Control-Allow-Origin", "*");
  }
  // If origin is present but not allowed, we omit Access-Control-Allow-Origin
  // which causes the browser to block the response (intended security behavior).

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
  return withCors(new Response(null, { status: 204 }), request);
}
