ALTER TABLE "ShopRateLimit"
  ALTER COLUMN "dailyLimitLoggedIn" SET DEFAULT 8,
  ALTER COLUMN "dailyLimitAnonymous" SET DEFAULT 8;

UPDATE "ShopRateLimit"
SET "dailyLimitLoggedIn" = 8,
    "dailyLimitAnonymous" = 8,
    "updatedAt" = NOW();

UPDATE "GenerationUsage"
SET "key" = "shop" || ':' || "key",
    "updatedAt" = NOW()
WHERE "key" NOT LIKE "shop" || ':%';
