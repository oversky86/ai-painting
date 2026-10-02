import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  type BusinessStatus,
  normalizeBusinessStatus,
} from "./business-status.server";

const BUCKET = "supplier-portraits";
const SIGNED_URL_TTL_SEC = 60 * 60; // 1 hour
/** Index rows that disagree with the metafield longer than this are treated as drift, not an in-flight write. */
const RECONCILE_AFTER_MS = 60 * 1000;

export class ConflictError extends Error {}

function throwDbError(error: { code?: string; message: string }): never {
  if (error.code === "23505") throw new ConflictError(error.message);
  throw new Error(error.message);
}

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

/**
 * Creates the index row, or refreshes name/email on an existing one.
 * `businessStatus` only seeds new rows; status changes go through `claimStatus`.
 */
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
  const existing = await getSupplierOrder(input.shop, input.shopifyOrderId);

  if (existing) {
    const patch: Record<string, unknown> = {};
    if (input.orderName && input.orderName !== existing.order_name) {
      patch.order_name = input.orderName;
    }
    if (
      input.customerEmail !== undefined &&
      input.customerEmail !== existing.customer_email
    ) {
      patch.customer_email = input.customerEmail;
    }
    if (!Object.keys(patch).length) return existing;
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
  if (error) {
    if (error.code === "23505") {
      const raced = await getSupplierOrder(input.shop, input.shopifyOrderId);
      if (raced) return raced;
    }
    throwDbError(error);
  }
  return data as SupplierOrderRow;
}

export async function getSupplierOrders(
  shop: string,
  shopifyOrderIds: string[],
): Promise<SupplierOrderRow[]> {
  if (!shopifyOrderIds.length) return [];
  const sb = getClient();
  const { data, error } = await sb
    .from("supplier_orders")
    .select("*")
    .eq("shop", shop)
    .in("shopify_order_id", shopifyOrderIds);
  if (error) throw new Error(error.message);
  return (data || []) as SupplierOrderRow[];
}

type StatusExtra = {
  versionCount?: number;
  modificationCount?: number;
  trackingCompany?: string | null;
  trackingNumber?: string | null;
};

function statusPatch(status: BusinessStatus, extra?: StatusExtra) {
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
  return patch;
}

/**
 * Compare-and-set on the index row: only moves `from -> to` when the row still
 * holds `from` (and the expected counters). Returns null when another request won.
 */
export async function claimStatus(input: {
  row: SupplierOrderRow;
  from: BusinessStatus;
  to: BusinessStatus;
  extra?: StatusExtra;
}): Promise<SupplierOrderRow | null> {
  const sb = getClient();
  const { data, error } = await sb
    .from("supplier_orders")
    .update(statusPatch(input.to, input.extra))
    .eq("id", input.row.id)
    .eq("business_status", input.from)
    .eq("version_count", input.row.version_count)
    .eq("modification_count", input.row.modification_count)
    .select("*");
  if (error) throw new Error(error.message);
  return ((data || [])[0] as SupplierOrderRow | undefined) || null;
}

/** Puts a claimed row back to its pre-claim snapshot. */
export async function restoreSupplierOrder(
  snapshot: SupplierOrderRow,
): Promise<void> {
  const sb = getClient();
  const { error } = await sb
    .from("supplier_orders")
    .update({
      business_status: snapshot.business_status,
      version_count: snapshot.version_count,
      modification_count: snapshot.modification_count,
      tracking_company: snapshot.tracking_company,
      tracking_number: snapshot.tracking_number,
      updated_at: new Date().toISOString(),
    })
    .eq("id", snapshot.id);
  if (error) {
    console.error("[supplier-store] restore failed", snapshot.id, error.message);
  }
}

/**
 * The metafield is the source of truth. When the index has disagreed for longer
 * than an in-flight write could take, rewrite the index to match it.
 */
export async function reconcileSupplierOrder(
  row: SupplierOrderRow,
  metafieldStatus: BusinessStatus,
): Promise<SupplierOrderRow> {
  if (row.business_status === metafieldStatus) return row;
  const age = Date.now() - new Date(row.updated_at).getTime();
  if (age < RECONCILE_AFTER_MS) return row;
  const sb = getClient();
  const { data, error } = await sb
    .from("supplier_orders")
    .update(statusPatch(metafieldStatus))
    .eq("id", row.id)
    .eq("business_status", row.business_status)
    .select("*");
  if (error) throw new Error(error.message);
  return ((data || [])[0] as SupplierOrderRow | undefined) || row;
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

/** Counts that exist only in the database. Order name, status, and tracking stay on the Shopify order. */
export async function supplierQueueExtras(
  shop: string,
  shopifyOrderIds: string[],
): Promise<{
  versionCount: Map<string, number>;
  modificationCount: Map<string, number>;
  latestNoteCount: Map<string, number>;
}> {
  const versionCount = new Map<string, number>();
  const modificationCount = new Map<string, number>();
  const latestNoteCount = new Map<string, number>();
  if (!shopifyOrderIds.length) {
    return { versionCount, modificationCount, latestNoteCount };
  }
  const versions = await listPortraitVersionsForOrders(shop, shopifyOrderIds);
  for (const [orderId, list] of versions) versionCount.set(orderId, list.length);
  const requests = await listModificationRequestsForOrders(shop, shopifyOrderIds);
  for (const [orderId, list] of requests) {
    modificationCount.set(orderId, list.length);
    const latest = list[list.length - 1];
    if (latest) latestNoteCount.set(orderId, latest.notes.length);
  }
  return { versionCount, modificationCount, latestNoteCount };
}

/** Note count of each order's most recent modification request. */
export async function latestNoteCounts(
  shop: string,
  shopifyOrderIds: string[],
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  if (!shopifyOrderIds.length) return counts;
  const requests = await listModificationRequestsForOrders(shop, shopifyOrderIds);
  for (const [orderId, list] of requests) {
    const latest = list[list.length - 1];
    if (latest) counts.set(orderId, latest.notes.length);
  }
  return counts;
}

const UPLOAD_FILE_PATTERN = {
  image: /^image\.(jpg|png|webp)$/,
  video: /^video\.(mp4|webm|mov)$/,
} as const;

export function uploadFolder(
  shop: string,
  shopifyOrderId: string,
  versionNumber: number,
): string {
  return `${shop}/${shopifyOrderId}/v${versionNumber}`;
}

/** True when `path` is this order/version's upload slot for `kind` and the object exists. */
export async function isValidUploadPath(input: {
  path: string;
  kind: "image" | "video";
  shop: string;
  shopifyOrderId: string;
  versionNumber: number;
}): Promise<boolean> {
  const folder = uploadFolder(input.shop, input.shopifyOrderId, input.versionNumber);
  if (!input.path.startsWith(`${folder}/`)) return false;
  const file = input.path.slice(folder.length + 1);
  if (!UPLOAD_FILE_PATTERN[input.kind].test(file)) return false;
  const { data, error } = await getClient().storage.from(BUCKET).exists(input.path);
  return !error && data === true;
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
  const path = `${uploadFolder(input.shop, input.shopifyOrderId, input.versionNumber)}/${input.kind}.${ext}`;

  // upsert lets the supplier retry an upload for a version that was never confirmed.
  const { data, error } = await sb.storage
    .from(BUCKET)
    .createSignedUploadUrl(path, { upsert: true });
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

export async function signedReadUrls(
  paths: string[],
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  const unique = [...new Set(paths.filter(Boolean))];
  if (!unique.length) return result;
  const { data, error } = await getClient()
    .storage.from(BUCKET)
    .createSignedUrls(unique, SIGNED_URL_TTL_SEC);
  if (error || !data) return result;
  for (const item of data) {
    if (item.path && item.signedUrl && !item.error) {
      result.set(item.path, item.signedUrl);
    }
  }
  return result;
}

export async function deletePortraitVersion(id: string): Promise<void> {
  const { error } = await getClient()
    .from("portrait_versions")
    .delete()
    .eq("id", id);
  if (error) console.error("[supplier-store] delete version failed", id, error.message);
}

export async function deleteModificationRequest(id: string): Promise<void> {
  const { error } = await getClient()
    .from("modification_requests")
    .delete()
    .eq("id", id);
  if (error) console.error("[supplier-store] delete request failed", id, error.message);
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
  if (error) throwDbError(error);
  return data as PortraitVersionRow;
}

export async function listPortraitVersionsForOrders(
  shop: string,
  shopifyOrderIds: string[],
): Promise<Map<string, PortraitVersionRow[]>> {
  const byOrder = new Map<string, PortraitVersionRow[]>();
  if (!shopifyOrderIds.length) return byOrder;
  const { data, error } = await getClient()
    .from("portrait_versions")
    .select("*")
    .eq("shop", shop)
    .in("shopify_order_id", shopifyOrderIds)
    .order("version_number", { ascending: true });
  if (error) throw new Error(error.message);
  for (const row of (data || []) as PortraitVersionRow[]) {
    const list = byOrder.get(row.shopify_order_id) || [];
    list.push(row);
    byOrder.set(row.shopify_order_id, list);
  }
  return byOrder;
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
  if (error) throwDbError(error);

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
    if (noteError) {
      await deleteModificationRequest(requestId);
      throw new Error(noteError.message);
    }
  }

  return {
    request: request as ModificationRequestRow,
    notes: noteRows as ModificationNoteRow[],
  };
}

export type ModificationRequestWithNotes = ModificationRequestRow & {
  notes: ModificationNoteRow[];
};

export async function listModificationRequests(
  shop: string,
  shopifyOrderId: string,
): Promise<ModificationRequestWithNotes[]> {
  const byOrder = await listModificationRequestsForOrders(shop, [shopifyOrderId]);
  return byOrder.get(shopifyOrderId) || [];
}

export async function listModificationRequestsForOrders(
  shop: string,
  shopifyOrderIds: string[],
): Promise<Map<string, ModificationRequestWithNotes[]>> {
  const byOrder = new Map<string, ModificationRequestWithNotes[]>();
  if (!shopifyOrderIds.length) return byOrder;
  const sb = getClient();
  const { data: requests, error } = await sb
    .from("modification_requests")
    .select("*")
    .eq("shop", shop)
    .in("shopify_order_id", shopifyOrderIds)
    .order("against_version", { ascending: true });
  if (error) throw new Error(error.message);
  const rows = (requests || []) as ModificationRequestRow[];
  if (!rows.length) return byOrder;

  const { data: notes, error: noteError } = await sb
    .from("modification_notes")
    .select("*")
    .in(
      "request_id",
      rows.map((r) => r.id),
    )
    .order("note_index", { ascending: true });
  if (noteError) throw new Error(noteError.message);

  const byRequest = new Map<string, ModificationNoteRow[]>();
  for (const note of (notes || []) as ModificationNoteRow[]) {
    const list = byRequest.get(note.request_id) || [];
    list.push(note);
    byRequest.set(note.request_id, list);
  }

  for (const r of rows) {
    const list = byOrder.get(r.shopify_order_id) || [];
    list.push({ ...r, notes: byRequest.get(r.id) || [] });
    byOrder.set(r.shopify_order_id, list);
  }
  return byOrder;
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
