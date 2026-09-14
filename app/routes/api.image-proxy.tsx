import type { LoaderFunctionArgs } from "react-router";
import { withCors, handleCorsPreflight } from "../utils/cors.server";
import { verifyAppProxySignature } from "../utils/app-proxy-verify";

/**
 * Same-origin image proxy so the storefront can canvas-crop Supabase images
 * without tainting the canvas (CORS).
 */
export async function loader({ request }: LoaderFunctionArgs) {
  const preflight = handleCorsPreflight(request);
  if (preflight) return preflight;

  if (!verifyAppProxySignature(request)) {
    return withCors(Response.json({ error: "Unauthorized" }, { status: 401 }), request);
  }

  const url = new URL(request.url);
  const src = url.searchParams.get("url") || "";
  if (!src || !/^https?:\/\//i.test(src)) {
    return withCors(Response.json({ error: "url required" }, { status: 400 }), request);
  }

  try {
    const host = new URL(src).hostname;
    const allowed =
      host.includes("supabase.co") ||
      host.includes("shopify.com") ||
      host.includes("cdn.shopify.com") ||
      host.endsWith(".myshopify.com");
    if (!allowed) {
      return withCors(Response.json({ error: "Host not allowed" }, { status: 403 }), request);
    }

    const upstream = await fetch(src);
    if (!upstream.ok) {
      return withCors(Response.json({ error: "Upstream failed" }, { status: 502 }), request);
    }

    const contentType = upstream.headers.get("content-type") || "image/jpeg";
    const buffer = await upstream.arrayBuffer();
    return withCors(
      new Response(buffer, {
        status: 200,
        headers: {
          "Content-Type": contentType,
          "Cache-Control": "public, max-age=3600",
        },
      }),
      request
    );
  } catch (error) {
    console.error("[image-proxy] failed:", error);
    return withCors(Response.json({ error: "Proxy failed" }, { status: 503 }), request);
  }
}
