import type { LoaderFunctionArgs } from "react-router";
import prisma from "../db.server";
import { deleteStoredImages } from "../utils/supabase.server";

const DAY_MS = 24 * 60 * 60 * 1000;
const RETENTION_EFFECTIVE_AT = new Date("2026-11-05T00:00:00.000Z");

function versionUrls(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object" || !("url" in item)) return [];
    const url = String(item.url || "");
    return url ? [url] : [];
  });
}

function authorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET || "";
  return Boolean(secret) && request.headers.get("authorization") === `Bearer ${secret}`;
}

export async function loader({ request }: LoaderFunctionArgs) {
  if (!authorized(request)) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const now = Date.now();
  const abandonedCutoff = new Date(now - 30 * DAY_MS);
  const orderedCutoff = new Date(now - 180 * DAY_MS);

  try {
    const staleSessions = await prisma.flowSession.findMany({
      where: { createdAt: { gte: RETENTION_EFFECTIVE_AT }, updatedAt: { lt: abandonedCutoff } },
      select: { id: true, photoUrl: true, resultUrl: true, versions: true },
    });
    const staleJobs = await prisma.generationJob.findMany({
      where: {
        createdAt: { gte: RETENTION_EFFECTIVE_AT },
        orderRecords: { none: {} },
        OR: [
          { shopifyOrderId: null, updatedAt: { lt: abandonedCutoff } },
          { shopifyOrderId: { not: null }, updatedAt: { lt: orderedCutoff } },
        ],
      },
      select: { id: true, petPhotoUrl: true, resultUrl: true },
    });

    const sessionUrls = staleSessions.flatMap((session) => [
      session.photoUrl || "",
      session.resultUrl || "",
      ...versionUrls(session.versions),
    ]).filter(Boolean);
    const staleJobUrls = staleJobs.flatMap((job) => [job.petPhotoUrl, job.resultUrl || ""]).filter(Boolean);
    const candidateUrls = Array.from(new Set([...sessionUrls, ...staleJobUrls]));
    const protectedJobs = candidateUrls.length
      ? await prisma.generationJob.findMany({
          where: {
            id: { notIn: staleJobs.map((job) => job.id) },
            OR: [{ petPhotoUrl: { in: candidateUrls } }, { resultUrl: { in: candidateUrls } }],
          },
          select: { petPhotoUrl: true, resultUrl: true },
        })
      : [];
    const protectedUrls = new Set(protectedJobs.flatMap((job) => [job.petPhotoUrl, job.resultUrl || ""]));
    const removableUrls = candidateUrls.filter((url) => !protectedUrls.has(url));

    await prisma.$transaction([
      prisma.flowSession.deleteMany({ where: { id: { in: staleSessions.map((session) => session.id) } } }),
      prisma.generationJob.deleteMany({ where: { id: { in: staleJobs.map((job) => job.id) } } }),
    ]);
    const removedObjects = await deleteStoredImages(removableUrls);

    return Response.json({
      ok: true,
      removed_sessions: staleSessions.length,
      removed_jobs: staleJobs.length,
      removed_storage_objects: removedObjects,
    });
  } catch (error) {
    console.error("[privacy-cleanup] failed:", error);
    return Response.json({ error: "Cleanup failed" }, { status: 503 });
  }
}
