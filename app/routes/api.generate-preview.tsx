import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { nanoid } from "nanoid";
import { createJob } from "../utils/job-store.server";
import { buildGenerationPrompt } from "../utils/prompts.server";
import { loadStylePromptOverrides } from "../utils/style-prompts.server";
import { withCors, handleCorsPreflight } from "../utils/cors.server";
import { verifyAppProxySignature, getShopFromProxy } from "../utils/app-proxy-verify";
import {
  checkDailyLimit,
  DAILY_PREVIEW_LIMIT_ERROR,
  releaseDailyLimit,
  type RateLimitResult,
} from "../utils/rate-limit";
import { createPrivateImageUrl, privateStoragePathFromUrl } from "../utils/supabase.server";

// Handle CORS preflight (OPTIONS)
export function loader({ request }: LoaderFunctionArgs) {
  const preflight = handleCorsPreflight(request);
  if (preflight) return preflight;
  return withCors(Response.json({ error: "Method not allowed" }, { status: 405 }), request);
}

export async function action({ request }: ActionFunctionArgs) {
  // Handle CORS preflight
  const preflight = handleCorsPreflight(request);
  if (preflight) return preflight;

  // Only allow POST
  if (request.method !== "POST") {
    return withCors(Response.json({ error: "Method not allowed" }, { status: 405 }), request);
  }

  // App Proxy HMAC verification
  if (!verifyAppProxySignature(request)) {
    return withCors(Response.json({ error: "Unauthorized" }, { status: 401 }), request);
  }

  let rateLimit: RateLimitResult | null = null;
  try {
    const { photo_url, style, keywords, generate } = await request.json();

    if (!photo_url || !style) {
      return withCors(Response.json(
        { error: "photo_url and style are required" },
        { status: 400 }
      ), request);
    }

    rateLimit = await checkDailyLimit(request);
    if (!rateLimit.allowed) {
      return withCors(Response.json(
        {
          code: DAILY_PREVIEW_LIMIT_ERROR,
          error: `Daily limit reached. You can generate ${rateLimit.limit} images per day. Try again tomorrow.`,
          limit: rateLimit.limit,
          remaining: 0,
          resets_at: rateLimit.resetsAt,
        },
        {
          status: 429,
          headers: {
            "X-RateLimit-Remaining": "0",
            "X-RateLimit-Limit": String(rateLimit.limit),
            "X-RateLimit-Reset": rateLimit.resetsAt,
          },
        }
      ), request);
    }

    const shop = getShopFromProxy(request);
    const jobId = nanoid();
    const userPrompt = typeof keywords === "string" ? keywords : "";
    const prompt = buildGenerationPrompt(
      style,
      userPrompt,
      await loadStylePromptOverrides(shop),
    );

    // Real Replicate mode: create prediction + async polling via job-status
    if (generate) {
      const { createPrediction } = await import("../utils/replicate.server");
      const privatePath = privateStoragePathFromUrl(photo_url);
      const processingUrl = privatePath ? await createPrivateImageUrl(privatePath) : photo_url;
      const prediction = await createPrediction(processingUrl, prompt);

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
        limit: rateLimit.limit,
        resets_at: rateLimit.resetsAt,
      }), request);
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
      limit: rateLimit.limit,
      resets_at: rateLimit.resetsAt,
    }), request);
  } catch (error) {
    console.error("Generate preview error:", error);
    if (rateLimit?.allowed) {
      try {
        await releaseDailyLimit(rateLimit);
      } catch (releaseError) {
        console.error("[rate-limit] Failed to release generation reservation:", releaseError);
      }
    }
    return withCors(Response.json(
      { error: "AI service temporarily unavailable. Please try again." },
      { status: 503 }
    ), request);
  }
}
