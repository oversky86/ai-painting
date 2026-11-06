/**
 * Daily rate limit checker for image generation.
 * Uses Prisma to track usage per customer_id or IP address.
 * Uses the product default when a shop has not saved an explicit limit.
 */
import { Prisma } from "@prisma/client";
import prisma from "../db.server";
import { getCustomerIdFromProxy, getShopFromProxy } from "./app-proxy-verify";

export const MAX_DAILY_PREVIEW_LIMIT = 8;
export const DEFAULT_DAILY_LIMIT = MAX_DAILY_PREVIEW_LIMIT;
export const DAILY_PREVIEW_LIMIT_ERROR = "DAILY_PREVIEW_LIMIT_REACHED";

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  limit: number;
  resetsAt: string;
  reservationKey?: string;
  reservationDate?: Date;
}

type UsageCount = { count: number };

export function normalizeDailyPreviewLimit(value: unknown): number {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_DAILY_LIMIT;
  return Math.min(parsed, MAX_DAILY_PREVIEW_LIMIT);
}

function dailyWindow() {
  const now = new Date();
  const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const resetsAt = new Date(date);
  resetsAt.setUTCDate(resetsAt.getUTCDate() + 1);
  return { date, resetsAt: resetsAt.toISOString() };
}

export async function checkDailyLimit(request: Request, visitorKey?: string, limitCap = MAX_DAILY_PREVIEW_LIMIT): Promise<RateLimitResult> {
  const shop = getShopFromProxy(request);
  const customerId = getCustomerIdFromProxy(request);
  const ip = request.headers.get("X-Forwarded-For")?.split(",")[0]?.trim() || "unknown";
  const window = dailyWindow();
  const normalizedVisitorKey = String(visitorKey || "").trim().replace(/^guest:/, "").slice(0, 128);
  const identity = customerId
    ? `customer:${customerId}`
    : (normalizedVisitorKey ? `visitor:${normalizedVisitorKey}` : `ip:${ip}`);
  const key = `${shop}:${identity}`;
  const settings = await prisma.shopRateLimit.findUnique({ where: { shop } });
  const configuredLimit = settings
    ? (customerId
        ? (settings.dailyLimitLoggedIn || DEFAULT_DAILY_LIMIT)
        : (settings.dailyLimitAnonymous || DEFAULT_DAILY_LIMIT))
    : DEFAULT_DAILY_LIMIT;
  const limit = Math.min(normalizeDailyPreviewLimit(configuredLimit), limitCap);

  // The conditional upsert reserves one generation without allowing concurrent
  // requests to push the counter past the configured daily limit.
  const usage = await prisma.$queryRaw<UsageCount[]>(Prisma.sql`
    INSERT INTO "GenerationUsage" ("key", "date", "count", "shop", "updatedAt")
    VALUES (${key}, ${window.date}, 1, ${shop}, NOW())
    ON CONFLICT ("key", "date") DO UPDATE
    SET "count" = "GenerationUsage"."count" + 1,
        "updatedAt" = NOW()
    WHERE "GenerationUsage"."count" < ${limit}
    RETURNING "count"
  `);

  if (!usage.length) {
    return { allowed: false, remaining: 0, limit, resetsAt: window.resetsAt };
  }

  return {
    allowed: true,
    remaining: Math.max(0, limit - Number(usage[0].count)),
    limit,
    resetsAt: window.resetsAt,
    reservationKey: key,
    reservationDate: window.date,
  };
}

export async function releaseDailyLimit(result: RateLimitResult): Promise<void> {
  if (!result.reservationKey || !result.reservationDate) return;

  await prisma.$executeRaw(Prisma.sql`
    UPDATE "GenerationUsage"
    SET "count" = GREATEST("count" - 1, 0),
        "updatedAt" = NOW()
    WHERE "key" = ${result.reservationKey}
      AND "date" = ${result.reservationDate}
      AND "count" > 0
  `);
}
