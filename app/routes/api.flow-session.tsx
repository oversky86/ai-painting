import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import prisma from "../db.server";
import { withCors, handleCorsPreflight } from "../utils/cors.server";
import {
  verifyAppProxySignature,
  getShopFromProxy,
  getCustomerIdFromProxy,
} from "../utils/app-proxy-verify";

const TTL_MS = 30 * 24 * 60 * 60 * 1000;

type SessionPayload = {
  photoUrl?: string | null;
  style?: string | null;
  keywords?: string | null;
  currentKeywords?: string | null;
  versions?: unknown;
  versionIndex?: number | null;
  jobId?: string | null;
  resultUrl?: string | null;
  screen?: string | null;
  previewPaused?: boolean | null;
  firstName?: string | null;
  email?: string | null;
  phone?: string | null;
  visitor_key?: string | null;
  migrate_from?: string | null;
  clear?: boolean | null;
};

function visitorKeyFromRequest(request: Request, body?: SessionPayload): string {
  const customerId = getCustomerIdFromProxy(request);
  if (customerId) return `customer:${customerId}`;
  const guest = String(body?.visitor_key || new URL(request.url).searchParams.get("visitor_key") || "").trim();
  if (!guest) return "";
  return guest.startsWith("guest:") ? guest : `guest:${guest}`;
}

function serializeSession(row: {
  photoUrl: string | null;
  style: string | null;
  keywords: string | null;
  currentKeywords: string | null;
  versions: unknown;
  versionIndex: number;
  jobId: string | null;
  resultUrl: string | null;
  screen: string | null;
  previewPaused: boolean;
  firstName: string | null;
  email: string | null;
  phone: string | null;
  updatedAt: Date;
}) {
  if (Date.now() - row.updatedAt.getTime() > TTL_MS) return {};
  return {
    photoUrl: row.photoUrl || "",
    style: row.style || "",
    keywords: row.keywords || "",
    currentKeywords: row.currentKeywords || "",
    versions: Array.isArray(row.versions) ? row.versions : [],
    versionIndex: row.versionIndex ?? -1,
    jobId: row.jobId || "",
    resultUrl: row.resultUrl || "",
    screen: row.screen || "",
    previewPaused: !!row.previewPaused,
    firstName: row.firstName || "",
    email: row.email || "",
    phone: row.phone || "",
  };
}

export async function loader({ request }: LoaderFunctionArgs) {
  const preflight = handleCorsPreflight(request);
  if (preflight) return preflight;

  if (!verifyAppProxySignature(request)) {
    return withCors(Response.json({ error: "Unauthorized" }, { status: 401 }), request);
  }

  const shop = getShopFromProxy(request);
  const visitorKey = visitorKeyFromRequest(request);
  if (!visitorKey) {
    return withCors(Response.json({}), request);
  }

  try {
    const row = await prisma.flowSession.findUnique({
      where: { shop_visitorKey: { shop, visitorKey } },
    });
    if (!row) return withCors(Response.json({}), request);
    return withCors(Response.json(serializeSession(row)), request);
  } catch (error) {
    console.error("[flow-session] GET failed:", error);
    return withCors(Response.json({}), request);
  }
}

export async function action({ request }: ActionFunctionArgs) {
  const preflight = handleCorsPreflight(request);
  if (preflight) return preflight;

  if (request.method !== "POST") {
    return withCors(Response.json({ error: "Method not allowed" }, { status: 405 }), request);
  }

  if (!verifyAppProxySignature(request)) {
    return withCors(Response.json({ error: "Unauthorized" }, { status: 401 }), request);
  }

  let body: SessionPayload = {};
  try {
    body = (await request.json()) as SessionPayload;
  } catch {
    return withCors(Response.json({ error: "Invalid JSON" }, { status: 400 }), request);
  }

  const shop = getShopFromProxy(request);
  const visitorKey = visitorKeyFromRequest(request, body);
  if (!visitorKey) {
    return withCors(Response.json({ error: "visitor_key required" }, { status: 400 }), request);
  }

  if (body.clear === true) {
    const keys = [visitorKey];
    const migrateFrom = String(body.migrate_from || "").trim();
    if (migrateFrom) {
      keys.push(migrateFrom.startsWith("guest:") ? migrateFrom : `guest:${migrateFrom}`);
    }
    try {
      await prisma.flowSession.deleteMany({
        where: { shop, visitorKey: { in: keys } },
      });
      return withCors(Response.json({ ok: true }), request);
    } catch (error) {
      console.error("[flow-session] clear failed:", error);
      return withCors(Response.json({ error: "Failed to clear session" }, { status: 503 }), request);
    }
  }

  const data = {
    photoUrl: body.photoUrl || null,
    style: body.style || null,
    keywords: body.keywords || null,
    currentKeywords: body.currentKeywords || null,
    versions: Array.isArray(body.versions) ? body.versions : [],
    versionIndex: typeof body.versionIndex === "number" ? body.versionIndex : -1,
    jobId: body.jobId || null,
    resultUrl: body.resultUrl || null,
    screen: body.screen || null,
    previewPaused: !!body.previewPaused,
    firstName: body.firstName || null,
    email: body.email || null,
    phone: body.phone || null,
  };

  try {
    const migrateFrom = String(body.migrate_from || "").trim();
    if (visitorKey.startsWith("customer:") && migrateFrom) {
      const guestKey = migrateFrom.startsWith("guest:") ? migrateFrom : `guest:${migrateFrom}`;
      const guestRow = await prisma.flowSession.findUnique({
        where: { shop_visitorKey: { shop, visitorKey: guestKey } },
      });
      if (guestRow) {
        await prisma.flowSession.delete({ where: { id: guestRow.id } }).catch(() => {});
        if (!data.photoUrl && guestRow.photoUrl) {
          Object.assign(data, {
            photoUrl: guestRow.photoUrl,
            style: guestRow.style,
            keywords: guestRow.keywords,
            currentKeywords: guestRow.currentKeywords,
            versions: guestRow.versions,
            versionIndex: guestRow.versionIndex,
            jobId: guestRow.jobId,
            resultUrl: guestRow.resultUrl,
            screen: guestRow.screen,
            previewPaused: guestRow.previewPaused,
            firstName: data.firstName || guestRow.firstName,
            email: data.email || guestRow.email,
            phone: data.phone || guestRow.phone,
          });
        }
      }
    }

    const row = await prisma.flowSession.upsert({
      where: { shop_visitorKey: { shop, visitorKey } },
      create: { shop, visitorKey, ...data },
      update: data,
    });

    return withCors(Response.json(serializeSession(row)), request);
  } catch (error) {
    console.error("[flow-session] PUT failed:", error);
    return withCors(
      Response.json({ error: "Failed to save session" }, { status: 503 }),
      request
    );
  }
}
