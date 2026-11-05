import type { LoaderFunctionArgs } from "react-router";
import { getShopFromProxy, verifyAppProxySignature } from "../utils/app-proxy-verify";
import { downloadPrivateImage } from "../utils/supabase.server";
import { handleCorsPreflight, withCors } from "../utils/cors.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const preflight = handleCorsPreflight(request);
  if (preflight) return preflight;
  if (!verifyAppProxySignature(request)) {
    return withCors(Response.json({ error: "Unauthorized" }, { status: 401 }), request);
  }

  const path = new URL(request.url).searchParams.get("path") || "";
  const shop = getShopFromProxy(request);
  const allowedPrefix = [`originals/${shop}/`, `paintings/${shop}/`];
  if (!allowedPrefix.some((prefix) => path.startsWith(prefix)) || path.includes("..")) {
    return withCors(Response.json({ error: "Invalid image path" }, { status: 403 }), request);
  }

  try {
    const image = await downloadPrivateImage(path);
    return withCors(new Response(image.body, {
      status: 200,
      headers: {
        "Content-Type": image.contentType,
        "Cache-Control": "private, max-age=300",
        "X-Content-Type-Options": "nosniff",
      },
    }), request);
  } catch (error) {
    console.error("[private-image] failed:", error);
    return withCors(Response.json({ error: "Image unavailable" }, { status: 404 }), request);
  }
}
