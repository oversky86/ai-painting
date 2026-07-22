import { type ActionFunctionArgs, type LoaderFunctionArgs } from "react-router";
import { createClient } from "@supabase/supabase-js";
import prisma from "../db.server";

export async function loader({ request }: LoaderFunctionArgs) {
  try {
    const sessions = await prisma.$queryRaw`
      SELECT id, shop, "accessToken", "isOnline" FROM "Session" ORDER BY id DESC LIMIT 5`;
    const sessionList = sessions as any[];
    if (!sessionList || sessionList.length === 0) {
      return Response.json({ status: "no_session", message: "No sessions found." });
    }
    const session = sessionList.find((s: any) => s.isOnline === false) || sessionList[0];
    const shop = session.shop;
    const accessToken = session.accessToken;
    if (!accessToken) {
      return Response.json({ status: "no_token", sessions: sessionList.map((s: any) => ({ id: s.id, shop: s.shop, hasToken: !!s.accessToken })) });
    }
    const listResp = await fetch(`https://${shop}/admin/api/2025-04/webhooks.json`, {
      headers: { "X-Shopify-Access-Token": accessToken },
    });
    const listData = await listResp.json() as any;
    const existing = (listData.webhooks || []).map((w: any) => ({ id: w.id, topic: w.topic, address: w.address }));
    const appUrl = process.env.SHOPIFY_APP_URL || "";
    const address = `${appUrl}/webhooks/orders/create`;
    const hasIt = existing.some((w: any) => w.topic === "orders/create");
    let createResult: any = "ALREADY_EXISTS";
    if (!hasIt) {
      const createResp = await fetch(`https://${shop}/admin/api/2025-04/webhooks.json`, {
        method: "POST",
        headers: { "X-Shopify-Access-Token": accessToken, "Content-Type": "application/json" },
        body: JSON.stringify({ webhook: { topic: "orders/create", address, format: "json" } }),
      });
      createResult = await createResp.json();
    }
    return Response.json({ status: "done", shop, webhookAddress: address, existingWebhooks: existing, createResult });
  } catch (e: any) {
    return Response.json({ error: e.message || "Unknown error", stack: e.stack?.split("\n").slice(0, 5).join("\n") }, { status: 500 });
  }
}

export async function action({ request }: ActionFunctionArgs) {
  const results: Record<string, unknown> = {};
  try {
    const connInfo = await prisma.$queryRaw`SELECT current_database() as db, current_user as usr, current_schema() as schema, version() as ver`;
    results.connectionInfo = connInfo;
  } catch (e: any) { results.connectionInfo = `ERROR: ${e.message}`; }
  try {
    const tables = await prisma.$queryRaw`SELECT tablename FROM pg_tables WHERE schemaname = 'public'`;
    results.existingTables = tables;
  } catch (e: any) { results.existingTables = `ERROR: ${e.message}`; }
  try {
    await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "Session" ("id" TEXT NOT NULL PRIMARY KEY,"shop" TEXT NOT NULL,"state" TEXT NOT NULL,"isOnline" BOOLEAN NOT NULL DEFAULT false,"scope" TEXT,"expires" TIMESTAMP(3),"accessToken" TEXT NOT NULL,"userId" BIGINT,"firstName" TEXT,"lastName" TEXT,"email" TEXT,"accountOwner" BOOLEAN NOT NULL DEFAULT false,"locale" TEXT,"collaborator" BOOLEAN DEFAULT false,"emailVerified" BOOLEAN DEFAULT false,"refreshToken" TEXT,"refreshTokenExpires" TIMESTAMP(3))`);
    results.sessionTable = "CREATED";
    await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "GenerationJob" ("id" TEXT NOT NULL PRIMARY KEY DEFAULT gen_random_uuid()::text,"shop" TEXT NOT NULL,"petPhotoUrl" TEXT NOT NULL,"paintingStyle" TEXT NOT NULL,"prompt" TEXT NOT NULL,"status" TEXT NOT NULL DEFAULT 'pending',"resultUrl" TEXT,"replicateId" TEXT,"shopifyOrderId" TEXT,"createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,"updatedAt" TIMESTAMP(3) NOT NULL)`);
    results.generationJobTable = "CREATED";
    await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "PaintingStyle" ("id" TEXT NOT NULL PRIMARY KEY DEFAULT gen_random_uuid()::text,"name" TEXT NOT NULL UNIQUE,"description" TEXT NOT NULL,"prompt" TEXT NOT NULL,"previewUrl" TEXT,"isActive" BOOLEAN NOT NULL DEFAULT true,"sortOrder" INTEGER NOT NULL DEFAULT 0)`);
    results.paintingStyleTable = "CREATED";
    await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "OrderRecord" ("id" TEXT NOT NULL PRIMARY KEY DEFAULT gen_random_uuid()::text,"shop" TEXT NOT NULL,"shopifyOrderId" TEXT NOT NULL UNIQUE,"generationJobId" TEXT NOT NULL,"customerEmail" TEXT,"totalAmount" TEXT,"createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,CONSTRAINT "OrderRecord_generationJobId_fkey" FOREIGN KEY ("generationJobId") REFERENCES "GenerationJob"("id") ON DELETE RESTRICT ON UPDATE CASCADE)`);
    results.orderRecordTable = "CREATED";
  } catch (e: any) { results.ddlError = `DDL FAILED: ${e.message}`; }
  try {
    const tables = await prisma.$queryRaw`SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`;
    results.tablesAfterDDL = tables;
  } catch (e: any) { results.tablesAfterDDL = `ERROR: ${e.message}`; }
  try {
    const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_KEY!);
    const { data, error } = await supabase.storage.listBuckets();
    results.supabaseStorage = error ? `ERROR: ${error.message}` : `OK — buckets: ${data.map((b) => b.name).join(", ")}`;
  } catch (e: any) { results.supabaseStorage = `EXCEPTION: ${e.message}`; }
  return Response.json({ status: "done", results, time: new Date().toISOString() });
}
