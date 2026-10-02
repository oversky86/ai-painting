import type { BusinessStatus } from "./business-status.server";
import {
  getSupplierOrders,
  loadPortraitProgress,
  reconcileSupplierOrder,
  signedReadUrls,
} from "./supplier-store.server";

export type PortraitHistory = {
  businessStatus: BusinessStatus;
  versionCount: number;
  modificationCount: number;
  versions: Array<{
    versionNumber: number;
    imageUrl: string | null;
    videoUrl: string | null;
    createdAt: string;
  }>;
  modificationRequests: Array<{
    againstVersion: number;
    createdAt: string;
    notes: Array<{
      id: string;
      text: string;
      selection: { x: number; y: number; width: number; height: number };
    }>;
  }>;
};

/**
 * Versions and notes for many orders with a fixed number of Supabase calls.
 * `businessStatus` comes from Shopify (source of truth); counts come from the
 * version and request rows, and drifted index rows are reconciled on the way.
 */
export async function buildPortraitHistories(
  shop: string,
  orders: Array<{ shopifyOrderId: string; businessStatus: BusinessStatus }>,
): Promise<Map<string, PortraitHistory>> {
  const ids = orders.map((o) => o.shopifyOrderId);
  const [indexRows, progressByOrder] = await Promise.all([
    getSupplierOrders(shop, ids),
    loadPortraitProgress(shop, orders),
  ]);
  const statusById = new Map(orders.map((o) => [o.shopifyOrderId, o.businessStatus]));

  const urls = await signedReadUrls(
    [...progressByOrder.values()]
      .flatMap((p) => p.versions)
      .flatMap((v) => [v.image_path, v.video_path || ""]),
  );

  await Promise.all(
    indexRows.map((row) => {
      const status = statusById.get(row.shopify_order_id);
      return status ? reconcileSupplierOrder(row, status) : null;
    }),
  );

  const result = new Map<string, PortraitHistory>();
  for (const o of orders) {
    const progress = progressByOrder.get(o.shopifyOrderId)!;
    result.set(o.shopifyOrderId, {
      businessStatus: o.businessStatus,
      versionCount: progress.versionCount,
      modificationCount: progress.modificationCount,
      versions: progress.versions.map((v) => ({
        versionNumber: v.version_number,
        imageUrl: urls.get(v.image_path) || null,
        videoUrl: v.video_path ? urls.get(v.video_path) || null : null,
        createdAt: v.created_at,
      })),
      modificationRequests: progress.requests.map((r) => ({
        againstVersion: r.against_version,
        createdAt: r.created_at,
        notes: r.notes.map((n) => ({
          id: n.id,
          text: n.text,
          selection: {
            x: Number(n.x),
            y: Number(n.y),
            width: Number(n.width),
            height: Number(n.height),
          },
        })),
      })),
    });
  }
  return result;
}
