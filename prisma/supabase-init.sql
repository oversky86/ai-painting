-- Prisma Schema SQL for Supabase PostgreSQL
-- Run this in: Supabase Dashboard → SQL Editor → New Query → Paste → Run

CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "isOnline" BOOLEAN NOT NULL DEFAULT false,
    "scope" TEXT,
    "expires" TIMESTAMP(3),
    "accessToken" TEXT NOT NULL,
    "userId" BIGINT,
    "firstName" TEXT,
    "lastName" TEXT,
    "email" TEXT,
    "accountOwner" BOOLEAN NOT NULL DEFAULT false,
    "locale" TEXT,
    "collaborator" BOOLEAN DEFAULT false,
    "emailVerified" BOOLEAN DEFAULT false,
    "refreshToken" TEXT,
    "refreshTokenExpires" TIMESTAMP(3),
    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "GenerationJob" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "petPhotoUrl" TEXT NOT NULL,
    "paintingStyle" TEXT NOT NULL,
    "prompt" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "resultUrl" TEXT,
    "replicateId" TEXT,
    "shopifyOrderId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "GenerationJob_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PaintingStyle" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "prompt" TEXT NOT NULL,
    "previewUrl" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "PaintingStyle_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "OrderRecord" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "shopifyOrderId" TEXT NOT NULL,
    "generationJobId" TEXT NOT NULL,
    "customerEmail" TEXT,
    "totalAmount" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "OrderRecord_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PaintingStyle_name_key" ON "PaintingStyle"("name");
CREATE UNIQUE INDEX "OrderRecord_shopifyOrderId_key" ON "OrderRecord"("shopifyOrderId");

ALTER TABLE "OrderRecord" ADD CONSTRAINT "OrderRecord_generationJobId_fkey" FOREIGN KEY ("generationJobId") REFERENCES "GenerationJob"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Insert default painting styles
INSERT INTO "PaintingStyle" ("id", "name", "description", "prompt", "sortOrder") VALUES
('classic-oil', 'Classic Oil', 'Traditional oil painting style with rich colors and visible brushstrokes', 'Transform this pet photo into a classic oil painting with rich warm colors, visible brushstrokes, and a timeless elegant feel, like a Renaissance portrait', 1),
('impressionist', 'Impressionist', 'Impressionist style with light, colorful brushstrokes and a dreamy atmosphere', 'Transform this pet photo into an impressionist painting with light colorful brushstrokes, soft edges, and a dreamy sunlit atmosphere, like a Monet painting', 2);
