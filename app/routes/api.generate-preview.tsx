import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { nanoid } from "nanoid";
import { createJob } from "../utils/job-store.server";
import { buildGenerationPrompt } from "../utils/prompts.server";
import { loadStylePromptOverrides } from "../utils/style-prompts.server";
import { withCors, handleCorsPreflight } from "../utils/cors.server";
import { verifyAppProxySignature, getShopFromProxy, getCustomerIdFromProxy } from "../utils/app-proxy-verify";
import {
  checkDailyLimit,
  DAILY_PREVIEW_LIMIT_ERROR,
  releaseDailyLimit,
  type RateLimitResult,
} from "../utils/rate-limit";
import { createPrivateImageUrl, privateStoragePathFromUrl } from "../utils/supabase.server";
import prisma from "../db.server";

const EMAIL_UNLOCK_REQUIRED = "EMAIL_REQUIRED_FOR_MORE_PREVIEWS";

function validEmail(value: unknown): string {
  const email = String(value || "").trim().slice(0, 320);
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : "";
}

async function emailUnlocked(request: Request, visitorKey: unknown, suppliedEmail: unknown): Promise<boolean> {
  if (getCustomerIdFromProxy(request)) return true;
  if (validEmail(suppliedEmail)) return true;
  const shop = getShopFromProxy(request);
  const guestId = String(visitorKey || "").trim().replace(/^guest:/, "").slice(0, 128);
  if (!guestId) return false;
  const session = await prisma.flowSession.findUnique({
    where: { shop_visitorKey: { shop, visitorKey: `guest:${guestId}` } },
    select: { email: true },
  });
  return Boolean(validEmail(session?.email));
}

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
    const { photo_url, style, keywords, generate, visitor_key, contact_email } = await request.json();

    if (!photo_url || !style) {
      return withCors(Response.json(
        { error: "photo_url and style are required" },
        { status: 400 }
      ), request);
    }

    const unlocked = await emailUnlocked(request, visitor_key, contact_email);
    rateLimit = await checkDailyLimit(request, visitor_key, unlocked ? 8 : 2);
    if (!rateLimit.allowed) {
      if (!unlocked) {
        return withCors(Response.json({
          code: EMAIL_UNLOCK_REQUIRED,
          error: "Enter your email to unlock 6 more previews today.",
          limit: 2,
          remaining: 0,
        }, { status: 403 }), request);
      }
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
