import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  type BusinessStatus,
  normalizeBusinessStatus,
} from "./business-status.server";

const BUCKET = "supplier-portraits";
const SIGNED_URL_TTL_SEC = 60 * 60; // 1 hour

let client: SupabaseClient | null = null;

function getClient(): SupabaseClient {
  if (client) return client;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) {
    throw new Error("SUPABASE_URL / SUPABASE_SERVICE_KEY not configured");
  }
  client = createClient(url, key);
  return client;
}

export type SupplierOrderRow = {
  id: string;
  shop: string;
  shopify_order_id: string;
  order_name: string;
  customer_email: string | null;
  business_status: string;
  version_count: number;
  modification_count: number;
  tracking_company: string | null;
  tracking_number: string | null;
  placed_at: string;
  updated_at: string;
};

export type PortraitVersionRow = {
  id: string;
  shop: string;
  shopify_order_id: string;
  version_number: number;
  image_path: string;
  video_path: string | null;
  created_at: string;
};

export type ModificationRequestRow = {
  id: string;
  shop: string;
  shopify_order_id: string;
  against_version: number;
  created_at: string;
};

export type ModificationNoteRow = {
  id: string;
  request_id: string;
  note_index: number;
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
};

function newId(prefix: string) {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "")}`;
}

export async function upsertSupplierOrder(input: {
  shop: string;
  shopifyOrderId: string;
  orderName?: string;
  customerEmail?: string | null;
  businessStatus?: BusinessStatus;
  placedAt?: string;
}): Promise<SupplierOrderRow> {
  const sb = getClient();
  const id = newId("so");
  const now = new Date().toISOString();
  const { data: existing } = await sb
    .from("supplier_orders")
    .select("*")
    .eq("shop", input.shop)
    .eq("shopify_order_id", input.shopifyOrderId)
    .maybeSingle();

  if (existing) {
    const patch: Record<string, unknown> = { updated_at: now };
    if (input.orderName) patch.order_name = input.orderName;
    if (input.customerEmail !== undefined) {
      patch.customer_email = input.customerEmail;
    }
    if (input.businessStatus) patch.business_status = input.businessStatus;
    const { data, error } = await sb
      .from("supplier_orders")
      .update(patch)
      .eq("id", existing.id)
      .select("*")
      .single();
    if (error) throw new Error(error.message);
    return data as SupplierOrderRow;
  }

  const row = {
    id,
    shop: input.shop,
    shopify_order_id: input.shopifyOrderId,
    order_name: input.orderName || `#${input.shopifyOrderId}`,
    customer_email: input.customerEmail || null,
    business_status: input.businessStatus || "order_placed",
    version_count: 0,
    modification_count: 0,
    placed_at: input.placedAt || now,
    updated_at: now,
  };
  const { data, error } = await sb
    .from("supplier_orders")
    .insert(row)
    .select("*")
    .single();
  if (error) throw new Error(error.message);
  return data as SupplierOrderRow;
}

export async function getSupplierOrder(
  shop: string,
  shopifyOrderId: string,
): Promise<SupplierOrderRow | null> {
  const sb = getClient();
  const { data, error } = await sb
    .from("supplier_orders")
    .select("*")
    .eq("shop", shop)
    .eq("shopify_order_id", shopifyOrderId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data as SupplierOrderRow | null) || null;
}

export async function listSupplierOrders(
  shop: string,
  tab: "action" | "waiting" | "done",
): Promise<SupplierOrderRow[]> {
  const sb = getClient();
  let statuses: BusinessStatus[];
  if (tab === "action") {
    statuses = ["order_placed", "supplier_modification", "prepare_shipment"];
  } else if (tab === "waiting") {
    statuses = ["portrait_review"];
  } else {
    statuses = ["shipped"];
  }

  const { data, error } = await sb
    .from("supplier_orders")
    .select("*")
    .eq("shop", shop)
    .in("business_status", statuses)
    .order("placed_at", { ascending: true });
  if (error) throw new Error(error.message);

  const rows = (data || []) as SupplierOrderRow[];
  const priority: Record<string, number> = {
    supplier_modification: 0,
    prepare_shipment: 1,
    order_placed: 2,
    portrait_review: 3,
    shipped: 4,
  };
  return rows.sort((a, b) => {
    const pa = priority[a.business_status] ?? 9;
    const pb = priority[b.business_status] ?? 9;
    if (pa !== pb) return pa - pb;
    return a.placed_at.localeCompare(b.placed_at);
  });
}

export async function setSupplierOrderStatus(
  shop: string,
  shopifyOrderId: string,
  status: BusinessStatus,
  extra?: {
    versionCount?: number;
    modificationCount?: number;
    trackingCompany?: string;
    trackingNumber?: string;
  },
): Promise<SupplierOrderRow> {
  const sb = getClient();
  const patch: Record<string, unknown> = {
    business_status: status,
    updated_at: new Date().toISOString(),
  };
  if (extra?.versionCount !== undefined) patch.version_count = extra.versionCount;
  if (extra?.modificationCount !== undefined) {
    patch.modification_count = extra.modificationCount;
  }
  if (extra?.trackingCompany !== undefined) {
    patch.tracking_company = extra.trackingCompany;
  }
  if (extra?.trackingNumber !== undefined) {
    patch.tracking_number = extra.trackingNumber;
  }

  const existing = await getSupplierOrder(shop, shopifyOrderId);
  if (!existing) {
    return upsertSupplierOrder({
      shop,
      shopifyOrderId,
      businessStatus: status,
    });
  }

  const { data, error } = await sb
    .from("supplier_orders")
    .update(patch)
    .eq("id", existing.id)
    .select("*")
    .single();
  if (error) throw new Error(error.message);
  return data as SupplierOrderRow;
}

export async function createUploadSignedUrl(input: {
  shop: string;
  shopifyOrderId: string;
  kind: "image" | "video";
  versionNumber: number;
  contentType: string;
}): Promise<{ path: string; uploadUrl: string; token: string }> {
  const sb = getClient();
  const ext =
    input.kind === "image"
      ? input.contentType.includes("png")
        ? "png"
        : input.contentType.includes("webp")
          ? "webp"
          : "jpg"
      : input.contentType.includes("webm")
        ? "webm"
        : input.contentType.includes("quicktime")
          ? "mov"
          : "mp4";
  const path = `${input.shop}/${input.shopifyOrderId}/v${input.versionNumber}/${input.kind}.${ext}`;

  const { data, error } = await sb.storage
    .from(BUCKET)
    .createSignedUploadUrl(path);
  if (error || !data) {
    throw new Error(error?.message || "Failed to create signed upload URL");
  }
  return { path, uploadUrl: data.signedUrl, token: data.token };
}

export async function signedReadUrl(path: string): Promise<string | null> {
  if (!path) return null;
  const sb = getClient();
  const { data, error } = await sb.storage
    .from(BUCKET)
    .createSignedUrl(path, SIGNED_URL_TTL_SEC);
  if (error || !data?.signedUrl) return null;
  return data.signedUrl;
}

export async function insertPortraitVersion(input: {
  shop: string;
  shopifyOrderId: string;
  versionNumber: number;
  imagePath: string;
  videoPath?: string | null;
}): Promise<PortraitVersionRow> {
  const sb = getClient();
  const row = {
    id: newId("pv"),
    shop: input.shop,
    shopify_order_id: input.shopifyOrderId,
    version_number: input.versionNumber,
    image_path: input.imagePath,
    video_path: input.videoPath || null,
    created_at: new Date().toISOString(),
  };
  const { data, error } = await sb
    .from("portrait_versions")
    .insert(row)
    .select("*")
    .single();
  if (error) throw new Error(error.message);
  return data as PortraitVersionRow;
}

export async function listPortraitVersions(
  shop: string,
  shopifyOrderId: string,
): Promise<PortraitVersionRow[]> {
  const sb = getClient();
  const { data, error } = await sb
    .from("portrait_versions")
    .select("*")
    .eq("shop", shop)
    .eq("shopify_order_id", shopifyOrderId)
    .order("version_number", { ascending: true });
  if (error) throw new Error(error.message);
  return (data || []) as PortraitVersionRow[];
}

export async function insertModificationRequest(input: {
  shop: string;
  shopifyOrderId: string;
  againstVersion: number;
  notes: Array<{
    text: string;
    selection: { x: number; y: number; width: number; height: number };
  }>;
}): Promise<{ request: ModificationRequestRow; notes: ModificationNoteRow[] }> {
  const sb = getClient();
  const requestId = newId("mr");
  const requestRow = {
    id: requestId,
    shop: input.shop,
    shopify_order_id: input.shopifyOrderId,
    against_version: input.againstVersion,
    created_at: new Date().toISOString(),
  };
  const { data: request, error } = await sb
    .from("modification_requests")
    .insert(requestRow)
    .select("*")
    .single();
  if (error) throw new Error(error.message);

  const noteRows = input.notes.map((note, index) => ({
    id: newId("mn"),
    request_id: requestId,
    note_index: index + 1,
    text: note.text.slice(0, 2000),
    x: note.selection.x,
    y: note.selection.y,
    width: note.selection.width,
    height: note.selection.height,
  }));

  if (noteRows.length) {
    const { error: noteError } = await sb
      .from("modification_notes")
      .insert(noteRows);
    if (noteError) throw new Error(noteError.message);
  }

  return {
    request: request as ModificationRequestRow,
    notes: noteRows as ModificationNoteRow[],
  };
}

export async function listModificationRequests(
  shop: string,
  shopifyOrderId: string,
): Promise<
  Array<
    ModificationRequestRow & {
      notes: ModificationNoteRow[];
    }
  >
> {
  const sb = getClient();
  const { data: requests, error } = await sb
    .from("modification_requests")
    .select("*")
    .eq("shop", shop)
    .eq("shopify_order_id", shopifyOrderId)
    .order("against_version", { ascending: true });
  if (error) throw new Error(error.message);
  const rows = (requests || []) as ModificationRequestRow[];
  if (!rows.length) return [];

  const ids = rows.map((r) => r.id);
  const { data: notes, error: noteError } = await sb
    .from("modification_notes")
    .select("*")
    .in("request_id", ids)
    .order("note_index", { ascending: true });
  if (noteError) throw new Error(noteError.message);

  const byRequest = new Map<string, ModificationNoteRow[]>();
  for (const note of (notes || []) as ModificationNoteRow[]) {
    const list = byRequest.get(note.request_id) || [];
    list.push(note);
    byRequest.set(note.request_id, list);
  }

  return rows.map((r) => ({
    ...r,
    notes: byRequest.get(r.id) || [],
  }));
}

export async function recordLoginFailure(ip: string): Promise<{
  failCount: number;
  lockedUntil: string | null;
}> {
  const sb = getClient();
  const now = new Date();
  const { data: existing } = await sb
    .from("supplier_login_attempts")
    .select("*")
    .eq("ip", ip)
    .maybeSingle();

  const failCount = (existing?.fail_count || 0) + 1;
  const lockedUntil =
    failCount >= 5
      ? new Date(now.getTime() + 15 * 60 * 1000).toISOString()
      : existing?.locked_until || null;

  const row = {
    ip,
    fail_count: failCount,
    locked_until: lockedUntil,
    updated_at: now.toISOString(),
  };
  const { error } = await sb.from("supplier_login_attempts").upsert(row);
  if (error) throw new Error(error.message);
  return { failCount, lockedUntil };
}

export async function clearLoginFailures(ip: string): Promise<void> {
  const sb = getClient();
  await sb.from("supplier_login_attempts").delete().eq("ip", ip);
}

export async function getLoginLock(ip: string): Promise<{
  locked: boolean;
  lockedUntil: string | null;
  failCount: number;
}> {
  const sb = getClient();
  const { data } = await sb
    .from("supplier_login_attempts")
    .select("*")
    .eq("ip", ip)
    .maybeSingle();
  if (!data) return { locked: false, lockedUntil: null, failCount: 0 };
  const lockedUntil = data.locked_until as string | null;
  if (lockedUntil && new Date(lockedUntil).getTime() > Date.now()) {
    return {
      locked: true,
      lockedUntil,
      failCount: data.fail_count || 0,
    };
  }
  return {
    locked: false,
    lockedUntil: null,
    failCount: data.fail_count || 0,
  };
}

export function currentBusinessStatus(
  row: SupplierOrderRow | null,
): BusinessStatus {
  return normalizeBusinessStatus(row?.business_status);
}
