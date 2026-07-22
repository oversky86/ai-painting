import Replicate from "replicate";

const replicate = new Replicate({ auth: process.env.REPLICATE_API_TOKEN! });

/**
 * Create a Replicate prediction (async, does not wait for result)
 * Uses google/nano-banana model for pet portrait generation
 */
export async function createPrediction(photoUrl: string, prompt: string) {
  const prediction = await replicate.predictions.create({
    version: process.env.REPLICATE_MODEL_VERSION!,
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
