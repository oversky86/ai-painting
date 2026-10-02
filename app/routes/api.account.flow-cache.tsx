import type { ActionFunctionArgs } from "react-router";
import prisma from "../db.server";
import { assertAccountHmac, resolveAllowedShop } from "../utils/hmac-auth.server";

const TTL_MS = 30 * 24 * 60 * 60 * 1000;

function json(data: unknown, status = 200) {
  return Response.json(data, { status });
}

function numericCustomerId(value: string): string {
  const id = value.trim();
  if (!id) return "";
  if (id.startsWith("gid://")) return id.split("/").pop() || "";
  return id;
}

export const loader = async () => json({ ok: true });

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return json({ ok: false, error: "Method not allowed" }, 405);
  }

  const rawBody = await request.text();
  const hmac = assertAccountHmac(request, rawBody);
  if (!hmac.ok) return json({ ok: false, error: hmac.error }, hmac.status);

  let body: { shop?: string; customerId?: string };
  try {
    body = JSON.parse(rawBody) as { shop?: string; customerId?: string };
  } catch {
    return json({ ok: false, error: "Invalid JSON body" }, 400);
  }

  const shop = resolveAllowedShop(body.shop);
  const customerId = numericCustomerId(String(body.customerId || ""));
  if (!shop || !customerId) return json({ ok: true, cached: false });

  try {
    const row = await prisma.flowSession.findUnique({
      where: { shop_visitorKey: { shop, visitorKey: `customer:${customerId}` } },
    });
    const fresh = !!row && Date.now() - row.updatedAt.getTime() <= TTL_MS;
    return json({ ok: true, cached: fresh && !!row?.photoUrl });
  } catch (error) {
    console.error("[flow-cache] lookup failed:", error);
    return json({ ok: true, cached: false });
  }
};
