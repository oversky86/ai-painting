import type { BusinessStatus } from "./business-status.server";
import {
  getSupplierOrders,
  listModificationRequestsForOrders,
  listPortraitVersionsForOrders,
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
 * `businessStatus` comes from the metafield (source of truth); drifted index
 * rows are reconciled on the way.
 */
export async function buildPortraitHistories(
  shop: string,
  orders: Array<{ shopifyOrderId: string; businessStatus: BusinessStatus }>,
): Promise<Map<string, PortraitHistory>> {
  const ids = orders.map((o) => o.shopifyOrderId);
  const [indexRows, versionsByOrder, requestsByOrder] = await Promise.all([
    getSupplierOrders(shop, ids),
    listPortraitVersionsForOrders(shop, ids),
    listModificationRequestsForOrders(shop, ids),
  ]);
  const indexById = new Map(indexRows.map((row) => [row.shopify_order_id, row]));

  const urls = await signedReadUrls(
    [...versionsByOrder.values()].flat().flatMap((v) => [v.image_path, v.video_path || ""]),
  );

  await Promise.all(
    orders.map(async (o) => {
      const row = indexById.get(o.shopifyOrderId);
      if (row) {
        indexById.set(o.shopifyOrderId, await reconcileSupplierOrder(row, o.businessStatus));
      }
    }),
  );

  const result = new Map<string, PortraitHistory>();
  for (const o of orders) {
    const versions = versionsByOrder.get(o.shopifyOrderId) || [];
    const requests = requestsByOrder.get(o.shopifyOrderId) || [];
    const index = indexById.get(o.shopifyOrderId);
    result.set(o.shopifyOrderId, {
      businessStatus: o.businessStatus,
      versionCount: index?.version_count ?? versions.length,
      modificationCount: index?.modification_count ?? requests.length,
      versions: versions.map((v) => ({
        versionNumber: v.version_number,
        imageUrl: urls.get(v.image_path) || null,
        videoUrl: v.video_path ? urls.get(v.video_path) || null : null,
        createdAt: v.created_at,
      })),
      modificationRequests: requests.map((r) => ({
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
