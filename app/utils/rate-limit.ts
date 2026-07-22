/**
 * Daily rate limit checker for image generation.
 * Uses Prisma to track usage per customer_id or IP address.
 * Falls back to DEFAULT_DAILY_LIMIT if config is unreadable.
 */
import prisma from "../db.server";
import { getCustomerIdFromProxy, getShopFromProxy } from "./app-proxy-verify";

const DEFAULT_DAILY_LIMIT = 10;

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  limit: number;
}

export async function checkDailyLimit(request: Request): Promise<RateLimitResult> {
  const shop = getShopFromProxy(request);
  const customerId = getCustomerIdFromProxy(request);
  const ip = request.headers.get("X-Forwarded-For")?.split(",")[0]?.trim() || "unknown";
  const today = new Date(new Date().toISOString().split("T")[0]); // UTC midnight

  const key = customerId ? `customer:${customerId}` : `ip:${ip}`;

  try {
    // Read merchant-configured limits; fallback to defaults on any error
    const settings = await prisma.shopRateLimit.findUnique({ where: { shop } });
    const limit = settings
      ? (customerId
          ? (settings.dailyLimitLoggedIn || DEFAULT_DAILY_LIMIT)
          : (settings.dailyLimitAnonymous || DEFAULT_DAILY_LIMIT))
      : DEFAULT_DAILY_LIMIT;

    const usage = await prisma.generationUsage.findUnique({
      where: { key_date: { key, date: today } },
    });

    const currentCount = usage?.count || 0;
    if (currentCount >= limit) {
      return { allowed: false, remaining: 0, limit };
    }

    // Increment counter
    await prisma.generationUsage.upsert({
      where: { key_date: { key, date: today } },
      update: { count: currentCount + 1 },
      create: { key, date: today, count: 1, shop },
    });

    return { allowed: true, remaining: limit - currentCount - 1, limit };
  } catch (error) {
    // Database error: don't block the request, allow with default limit
    console.error("[rate-limit] Check failed, allowing request:", error);
    return { allowed: true, remaining: DEFAULT_DAILY_LIMIT, limit: DEFAULT_DAILY_LIMIT };
  }
}
