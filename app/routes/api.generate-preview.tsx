import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { nanoid } from "nanoid";
import { createJob } from "../utils/job-store.server";
import { buildPrompt } from "../utils/prompts.server";
import { withCors, handleCorsPreflight } from "../utils/cors.server";
import { verifyAppProxySignature, getShopFromProxy } from "../utils/app-proxy-verify";
import { checkDailyLimit } from "../utils/rate-limit";

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

  // Daily rate limit check
  const rateLimit = await checkDailyLimit(request);
  if (!rateLimit.allowed) {
    return withCors(Response.json(
      { error: `Daily limit reached. You can generate ${rateLimit.limit} images per day. Try again tomorrow.` },
      { status: 429, headers: { "X-RateLimit-Remaining": "0", "X-RateLimit-Limit": String(rateLimit.limit) } }
    ));
  }

  try {
    const { photo_url, style, generate } = await request.json();

    if (!photo_url || !style) {
      return withCors(Response.json(
        { error: "photo_url and style are required" },
        { status: 400 }
      ));
    }

    const shop = getShopFromProxy(request);
    const jobId = nanoid();
    const prompt = buildPrompt(style);

    // Real Replicate mode: create prediction + async polling via job-status
    if (generate) {
      const { createPrediction } = await import("../utils/replicate.server");
      const prediction = await createPrediction(photo_url, prompt);

      await createJob({
        id: jobId,
        shop,
        petPhotoUrl: photo_url,
        paintingStyle: style,
        prompt,
        status: "processing",
        replicateId: prediction.id,
        resultUrl: null,
      });

      return withCors(Response.json({
        job_id: jobId,
        status: "accepted",
        remaining: rateLimit.remaining,
      }));
    }

    // Mock mode: immediately complete with uploaded photo as result
    await createJob({
      id: jobId,
      shop,
      petPhotoUrl: photo_url,
      paintingStyle: style,
      prompt,
      status: "completed",
      replicateId: null,
      resultUrl: photo_url,
    });

    return withCors(Response.json({
      job_id: jobId,
      status: "accepted",
      remaining: rateLimit.remaining,
    }));
  } catch (error) {
    console.error("Generate preview error:", error);
    return withCors(Response.json(
      { error: "AI service temporarily unavailable. Please try again." },
      { status: 503 }
    ));
  }
}
