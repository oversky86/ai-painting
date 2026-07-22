import { type LoaderFunctionArgs } from "react-router";

export function loader(_args: LoaderFunctionArgs) {
  return Response.json({
    status: "ok",
    time: new Date().toISOString(),
    env: {
      SHOPIFY_API_KEY: !!process.env.SHOPIFY_API_KEY,
      SHOPIFY_API_SECRET: !!process.env.SHOPIFY_API_SECRET,
      DATABASE_URL: !!process.env.DATABASE_URL,
      SUPABASE_URL: !!process.env.SUPABASE_URL,
      SUPABASE_SERVICE_KEY: !!process.env.SUPABASE_SERVICE_KEY,
      REPLICATE_API_TOKEN: !!process.env.REPLICATE_API_TOKEN,
      SHOPIFY_APP_URL: process.env.SHOPIFY_APP_URL || "(not set)",
    },
  });
}
