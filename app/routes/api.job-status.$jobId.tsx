import type { LoaderFunctionArgs } from "react-router";
import { getJob, updateJob } from "../utils/job-store.server";
import { getPrediction, downloadImage } from "../utils/replicate.server";
import { uploadPainting } from "../utils/supabase.server";
import { withCors, handleCorsPreflight } from "../utils/cors.server";
import { verifyAppProxySignature } from "../utils/app-proxy-verify";

export async function loader({ params, request }: LoaderFunctionArgs) {
  // Handle CORS preflight
  const preflight = handleCorsPreflight(request);
  if (preflight) return preflight;

  // Only allow GET
  if (request.method !== "GET") {
    return withCors(Response.json({ error: "Method not allowed" }, { status: 405 }));
  }

  // App Proxy HMAC verification
  if (!verifyAppProxySignature(request)) {
    return withCors(Response.json({ error: "Unauthorized" }, { status: 401 }));
  }

  const jobId = params.jobId;
  if (!jobId) {
    return withCors(Response.json({ status: "not_found" }, { status: 404 }));
  }

  try {
    // Look up the job
    const job = await getJob(jobId);

    if (!job) {
      return withCors(Response.json({ status: "not_found" }, { status: 404 }));
    }

    // If already completed, return cached result
    if (job.status === "completed") {
      return withCors(Response.json({ status: "completed", result_url: job.resultUrl }));
    }

    // If already failed, return error
    if (job.status === "failed") {
      return withCors(Response.json({ status: "failed", error: "Generation failed" }));
    }

    // Poll Replicate for prediction status
    if (!job.replicateId) {
      return withCors(Response.json({ status: "processing" }));
    }

    const prediction = await getPrediction(job.replicateId);

    // Handle failed prediction
    if (prediction.status === "failed") {
      await updateJob(jobId, { status: "failed" });
      return withCors(Response.json({
        status: "failed",
        error: prediction.error || "Generation failed",
      }));
    }

    // Handle successful prediction: download → upload to Supabase
    if (prediction.status === "succeeded" && prediction.output) {
      const outputUrl =
        typeof prediction.output === "string"
          ? prediction.output
          : Array.isArray(prediction.output)
            ? prediction.output[0]
            : "";

      if (!outputUrl) {
        return withCors(Response.json({ status: "processing" }));
      }

      // Image transfer: Replicate output → memory download → Supabase Storage upload
      const imageBuffer = await downloadImage(outputUrl);
      const paintingUrl = await uploadPainting(imageBuffer, job.shop, jobId);

      // Update job with result
      await updateJob(jobId, { status: "completed", resultUrl: paintingUrl });

      return withCors(Response.json({ status: "completed", result_url: paintingUrl }));
    }

    // Still processing
    return withCors(Response.json({ status: "processing" }));
  } catch (error) {
    console.error("Job status check error:", error);
    return withCors(Response.json({ status: "processing" }));
  }
}
