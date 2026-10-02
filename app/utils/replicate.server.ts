import Replicate from "replicate";

const replicate = new Replicate({ auth: process.env.REPLICATE_API_TOKEN! });

/** Official Replicate model for Nano Banana 2. A pinned version hash was an older model. */
const IMAGE_MODEL = "google/nano-banana-2";

/**
 * Create a Replicate prediction (async, does not wait for result).
 * Nano Banana 2 edits the uploaded photo from a natural-language prompt.
 */
export async function createPrediction(photoUrl: string, prompt: string) {
  const prediction = await replicate.predictions.create({
    model: IMAGE_MODEL,
    input: {
      prompt,
      image_input: [photoUrl],
      aspect_ratio: "match_input_image",
      output_format: "jpg",
    },
  });
  return prediction; // { id, status: "starting" }
}

/**
 * Get prediction status and result
 * Returns: { id, status: "succeeded"|"processing"|"failed", output: "https://..." }
 */
export async function getPrediction(predictionId: string) {
  return replicate.predictions.get(predictionId);
}

/**
 * Download image from URL to Buffer (for memory-based image transfer)
 * Used to transfer Replicate output → Supabase Storage
 */
export async function downloadImage(url: string): Promise<Buffer> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Download failed: ${response.status}`);
  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}
