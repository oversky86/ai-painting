import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY! // Server-side key (bypasses RLS)
);

const BUCKET = "pet-painting";
const PRIVATE_BUCKET = "pet-painting-private";
let privateBucketReady: Promise<void> | null = null;

function ensurePrivateBucket(): Promise<void> {
  if (privateBucketReady) return privateBucketReady;
  privateBucketReady = supabase.storage.getBucket(PRIVATE_BUCKET).then(async ({ data, error }) => {
    if (data && !error) return;
    const created = await supabase.storage.createBucket(PRIVATE_BUCKET, {
      public: false,
      fileSizeLimit: 10 * 1024 * 1024,
      allowedMimeTypes: ["image/jpeg"],
    });
    if (created.error && !/already exists/i.test(created.error.message)) {
      throw new Error(`Private storage setup failed: ${created.error.message}`);
    }
  }).catch((error) => {
    privateBucketReady = null;
    throw error;
  });
  return privateBucketReady;
}

function protectedImageUrl(shop: string, key: string, origin?: string | null): string {
  let base = `https://${shop}`;
  if (origin) {
    try {
      const candidate = new URL(origin);
      const allowedHosts = new Set([
        shop,
        "viewbrush.com",
        "www.viewbrush.com",
        "6hcr01-9t.myshopify.com",
        "view-brush.myshopify.com",
        "e-commerce-dev-v6yidmlw.myshopify.com",
      ]);
      if (candidate.protocol === "https:" && allowedHosts.has(candidate.hostname)) base = candidate.origin;
    } catch {
      // Fall back to the canonical shop host.
    }
  }
  return `${base}/apps/piktura/api/private-image?path=${encodeURIComponent(key)}`;
}

export function privateStoragePathFromUrl(value: string): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (!url.pathname.endsWith("/apps/piktura/api/private-image")) return null;
    return url.searchParams.get("path");
  } catch {
    return null;
  }
}

export async function createPrivateImageUrl(path: string, expiresIn = 3600): Promise<string> {
  await ensurePrivateBucket();
  const { data, error } = await supabase.storage.from(PRIVATE_BUCKET).createSignedUrl(path, expiresIn);
  if (error || !data?.signedUrl) throw new Error(`Private image signing failed: ${error?.message || "unknown"}`);
  return data.signedUrl;
}

export async function downloadPrivateImage(path: string): Promise<{ body: Blob; contentType: string }> {
  await ensurePrivateBucket();
  const { data, error } = await supabase.storage.from(PRIVATE_BUCKET).download(path);
  if (error || !data) throw new Error(`Private image download failed: ${error?.message || "unknown"}`);
  return { body: data, contentType: data.type || "image/jpeg" };
}

export function storagePathFromUrl(value: string): string | null {
  if (!value) return null;
  const marker = `/storage/v1/object/public/${BUCKET}/`;
  try {
    const url = new URL(value);
    const markerIndex = url.pathname.indexOf(marker);
    if (markerIndex < 0) return null;
    return decodeURIComponent(url.pathname.slice(markerIndex + marker.length));
  } catch {
    return null;
  }
}

export async function deleteStoredImages(urls: string[]): Promise<number> {
  const publicPaths = Array.from(new Set(urls.map(storagePathFromUrl).filter((path): path is string => Boolean(path))));
  const privatePaths = new Set(urls.map(privateStoragePathFromUrl).filter((path): path is string => Boolean(path)));
  let removed = 0;
  for (let index = 0; index < publicPaths.length; index += 1000) {
    const batch = publicPaths.slice(index, index + 1000);
    const { error } = await supabase.storage.from(BUCKET).remove(batch);
    if (error) throw new Error(`Storage cleanup failed: ${error.message}`);
    removed += batch.length;
  }
  if (privatePaths.size) {
    await ensurePrivateBucket();
    for (const path of Array.from(privatePaths)) {
      const slash = path.lastIndexOf("/");
      if (slash < 0) continue;
      const folder = path.slice(0, slash);
      const { data, error } = await supabase.storage.from(PRIVATE_BUCKET).list(folder, { limit: 1000 });
      if (error) throw new Error(`Private storage listing failed: ${error.message}`);
      data?.forEach((object) => privatePaths.add(`${folder}/${object.name}`));
    }
  }
  const privatePathList = Array.from(privatePaths);
  for (let index = 0; index < privatePathList.length; index += 1000) {
    const batch = privatePathList.slice(index, index + 1000);
    const { error } = await supabase.storage.from(PRIVATE_BUCKET).remove(batch);
    if (error) throw new Error(`Private storage cleanup failed: ${error.message}`);
    removed += batch.length;
  }
  return removed;
}

/**
 * Upload original pet photo to Supabase Storage
 * Path: originals/{shop}/{jobId}/original.jpg
 */
export async function uploadOriginalPhoto(
  imageBuffer: Buffer,
  shop: string,
  jobId: string,
  origin?: string | null,
): Promise<string> {
  const key = `originals/${shop}/${jobId}/original.jpg`;
  await ensurePrivateBucket();
  const { error } = await supabase.storage.from(PRIVATE_BUCKET).upload(key, imageBuffer, {
    contentType: "image/jpeg",
    cacheControl: "31536000", // 1 year cache
    upsert: false,
  });
  if (error) throw new Error(`Upload original failed: ${error.message}`);

  return protectedImageUrl(shop, key, origin);
}

/**
 * Upload generated painting to Supabase Storage
 * Path: paintings/{shop}/{jobId}/painting.jpg
 */
export async function uploadPainting(
  imageBuffer: Buffer,
  shop: string,
  jobId: string,
  origin?: string | null,
  fileName = "painting.jpg",
): Promise<string> {
  const key = `paintings/${shop}/${jobId}/${fileName}`;
  await ensurePrivateBucket();
  const { error } = await supabase.storage.from(PRIVATE_BUCKET).upload(key, imageBuffer, {
    contentType: "image/jpeg",
    cacheControl: "31536000",
    upsert: false,
  });
  if (error) throw new Error(`Upload painting failed: ${error.message}`);

  return protectedImageUrl(shop, key, origin);
}

/**
 * Check if a painting already exists in storage
 */
export async function checkPaintingExists(
  shop: string,
  jobId: string
): Promise<{ exists: boolean; url?: string }> {
  const key = `paintings/${shop}/${jobId}/painting.jpg`;
  await ensurePrivateBucket();
  const { data, error } = await supabase.storage
    .from(PRIVATE_BUCKET)
    .list(`paintings/${shop}/${jobId}/`, { limit: 1, search: "painting.jpg" });

  if (error || !data || data.length === 0) return { exists: false };

  return { exists: true, url: protectedImageUrl(shop, key) };
}
