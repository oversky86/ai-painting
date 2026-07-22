import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { nanoid } from "nanoid";
import { uploadOriginalPhoto } from "../utils/supabase.server";
import { withCors, handleCorsPreflight } from "../utils/cors.server";
import { verifyAppProxySignature, getShopFromProxy } from "../utils/app-proxy-verify";

const ACCEPTED_TYPES = ["image/jpeg", "image/png", "image/webp"];
const MAX_SIZE = 10 * 1024 * 1024; // 10MB

// Handle CORS preflight (OPTIONS)
export function loader({ request }: LoaderFunctionArgs) {
  const preflight = handleCorsPreflight(request);
  if (preflight) return preflight;
  return withCors(Response.json({ error: "Method not allowed" }, { status: 405 }));
}

export async function action({ request }: ActionFunctionArgs) {
  // Handle CORS preflight
  const preflight = handleCorsPreflight(request);
  if (preflight) return preflight;

  // Only allow POST
  if (request.method !== "POST") {
    return withCors(Response.json({ error: "Method not allowed" }, { status: 405 }));
  }

  // App Proxy HMAC verification
  if (!verifyAppProxySignature(request)) {
    return withCors(Response.json({ error: "Unauthorized" }, { status: 401 }));
  }

  try {
    console.log("[upload] Received request, method:", request.method);
    const formData = await request.formData();
    const file = formData.get("photo") as File | null;

    if (!file) {
      return withCors(Response.json({ error: "No photo provided" }, { status: 400 }));
    }

    console.log("[upload] File received:", file.name, file.type, `${(file.size / 1024).toFixed(1)}KB`);

    // Validate file type
    if (!ACCEPTED_TYPES.includes(file.type)) {
      return withCors(
        Response.json({ error: "Invalid file type. Accepted: JPG, PNG, WebP" }, { status: 400 })
      );
    }

    // Validate file size
    if (file.size > MAX_SIZE) {
      return withCors(Response.json({ error: "File too large. Maximum size is 10MB" }, { status: 400 }));
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    const shop = getShopFromProxy(request);
    const jobId = nanoid();

    console.log("[upload] Uploading to Supabase Storage, shop:", shop, "jobId:", jobId);
    const photoUrl = await uploadOriginalPhoto(buffer, shop, jobId);
    console.log("[upload] Success:", photoUrl);

    return withCors(Response.json({ photo_url: photoUrl, job_id: jobId }));
  } catch (error: any) {
    console.error("[upload] Error:", error?.message || error, error?.stack || "");
    return withCors(
      Response.json({ error: "Upload failed. Please try again.", detail: error?.message || "unknown" }, { status: 503 })
    );
  }
}
