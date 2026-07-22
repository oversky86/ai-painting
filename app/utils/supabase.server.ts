import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY! // Server-side key (bypasses RLS)
);

const BUCKET = "pet-painting";

/**
 * Upload original pet photo to Supabase Storage
 * Path: originals/{shop}/{jobId}/original.jpg
 */
export async function uploadOriginalPhoto(
  imageBuffer: Buffer,
  shop: string,
  jobId: string
): Promise<string> {
  const key = `originals/${shop}/${jobId}/original.jpg`;
  const { error } = await supabase.storage.from(BUCKET).upload(key, imageBuffer, {
    contentType: "image/jpeg",
    cacheControl: "31536000", // 1 year cache
    upsert: false,
  });
  if (error) throw new Error(`Upload original failed: ${error.message}`);

  const { data } = supabase.storage.from(BUCKET).getPublicUrl(key);
  return data.publicUrl;
}

/**
 * Upload generated painting to Supabase Storage
 * Path: paintings/{shop}/{jobId}/painting.jpg
 */
export async function uploadPainting(
  imageBuffer: Buffer,
  shop: string,
  jobId: string
): Promise<string> {
  const key = `paintings/${shop}/${jobId}/painting.jpg`;
  const { error } = await supabase.storage.from(BUCKET).upload(key, imageBuffer, {
    contentType: "image/jpeg",
    cacheControl: "31536000",
    upsert: false,
  });
  if (error) throw new Error(`Upload painting failed: ${error.message}`);

  const { data } = supabase.storage.from(BUCKET).getPublicUrl(key);
  return data.publicUrl;
}

/**
 * Check if a painting already exists in storage
 */
export async function checkPaintingExists(
  shop: string,
  jobId: string
): Promise<{ exists: boolean; url?: string }> {
  const key = `paintings/${shop}/${jobId}/painting.jpg`;
  const { data, error } = await supabase.storage
    .from(BUCKET)
    .list(`${shop}/${jobId}/`, { limit: 1, search: "painting.jpg" });

  if (error || !data || data.length === 0) return { exists: false };

  const { data: urlData } = supabase.storage.from(BUCKET).getPublicUrl(key);
  return { exists: true, url: urlData.publicUrl };
}
