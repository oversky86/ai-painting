/**
 * Job store abstraction: uses in-memory Map for local dev,
 * Prisma for production. This avoids database connectivity
 * issues during local development.
 */

import prisma from "../db.server";

export interface JobRecord {
  id: string;
  shop: string;
  petPhotoUrl: string;
  paintingStyle: string;
  prompt: string;
  status: "processing" | "completed" | "failed";
  replicateId: string | null;
  resultUrl: string | null;
}

const isDev = process.env.NODE_ENV !== "production";

// In-memory store for local development
const memoryStore = new Map<string, JobRecord>();

export async function createJob(data: JobRecord): Promise<void> {
  if (isDev) {
    memoryStore.set(data.id, { ...data });
    console.log(`[job-store/memory] Created job ${data.id}`);
    return;
  }

  await prisma.generationJob.create({
    data: {
      id: data.id,
      shop: data.shop,
      petPhotoUrl: data.petPhotoUrl,
      paintingStyle: data.paintingStyle,
      prompt: data.prompt,
      status: data.status,
      replicateId: data.replicateId,
      resultUrl: data.resultUrl,
    },
  });
}

export async function getJob(id: string): Promise<JobRecord | null> {
  if (isDev) {
    const job = memoryStore.get(id);
    return job ? { ...job } : null;
  }

  const job = await prisma.generationJob.findUnique({ where: { id } });
  if (!job) return null;
  return {
    id: job.id,
    shop: job.shop,
    petPhotoUrl: job.petPhotoUrl,
    paintingStyle: job.paintingStyle,
    prompt: job.prompt,
    status: job.status as JobRecord["status"],
    replicateId: job.replicateId,
    resultUrl: job.resultUrl,
  };
}

export async function updateJob(
  id: string,
  data: Partial<Pick<JobRecord, "status" | "resultUrl">>
): Promise<void> {
  if (isDev) {
    const job = memoryStore.get(id);
    if (job) {
      Object.assign(job, data);
      console.log(`[job-store/memory] Updated job ${id}:`, data);
    }
    return;
  }

  await prisma.generationJob.update({
    where: { id },
    data,
  });
}
