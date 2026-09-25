import { canTransition, type BusinessStatus } from "./business-status.server";
import {
  getOrderBusinessStatus,
  setOrderBusinessStatus,
} from "./shopify-order.server";
import {
  ConflictError,
  claimStatus,
  reconcileSupplierOrder,
  restoreSupplierOrder,
  type SupplierOrderRow,
} from "./supplier-store.server";

type AdminClient = Parameters<typeof setOrderBusinessStatus>[0];
type StatusExtra = Parameters<typeof claimStatus>[0]["extra"];

/** Thrown from `apply` to abort the transition with a specific HTTP status. */
export class TransitionAbort extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export type TransitionResult<T> =
  | { ok: true; row: SupplierOrderRow; result: T }
  | { ok: false; status: number; error: string };

const BUSY_MESSAGE =
  "This order was just updated by another request. Refresh and try again.";

/**
 * Moves an order `current -> next` (current = the metafield value).
 *
 * The Supabase index row is claimed first with a compare-and-set, so concurrent
 * requests get 409 instead of both passing the check. Then `apply` runs the side
 * effect (insert version, fulfill, ...), and the metafield is written last. Any
 * failure before the metafield write undoes the side effect and restores the row.
 */
export async function runTransition<T = undefined>(input: {
  admin: AdminClient;
  ownerId: string;
  index: SupplierOrderRow;
  current: BusinessStatus;
  next: BusinessStatus;
  extra?: StatusExtra;
  apply?: () => Promise<T>;
  undo?: (result: T) => Promise<void>;
  /** The side effect cannot be undone (Shopify fulfillment): keep the claim if the metafield write fails. */
  irreversible?: boolean;
}): Promise<TransitionResult<T>> {
  const { admin, ownerId, current, next } = input;
  if (!canTransition(current, next)) {
    return { ok: false, status: 409, error: `Cannot move order from ${current} to ${next}` };
  }

  const index = await reconcileSupplierOrder(input.index, current);
  if (index.business_status !== current) {
    return { ok: false, status: 409, error: BUSY_MESSAGE };
  }

  const claimed = await claimStatus({ row: index, from: current, to: next, extra: input.extra });
  if (!claimed) {
    return { ok: false, status: 409, error: BUSY_MESSAGE };
  }

  let result = undefined as T;
  try {
    if (input.apply) result = await input.apply();
  } catch (err) {
    await restoreSupplierOrder(index);
    if (err instanceof ConflictError) {
      return { ok: false, status: 409, error: BUSY_MESSAGE };
    }
    if (err instanceof TransitionAbort) {
      return { ok: false, status: err.status, error: err.message };
    }
    throw err;
  }

  try {
    await setOrderBusinessStatus(admin, ownerId, next);
  } catch (err) {
    console.error("[transition] metafield write failed", ownerId, next, err);
    const landed = await getOrderBusinessStatus(admin, ownerId).catch(() => null);
    if (landed === next) return { ok: true, row: claimed, result };

    if (input.irreversible) {
      return {
        ok: false,
        status: 502,
        error:
          "Shopify accepted the change, but the order status could not be saved. Wait a minute, then submit again to finish.",
      };
    }
    if (input.undo) {
      await input.undo(result).catch((undoErr) =>
        console.error("[transition] undo failed", ownerId, undoErr),
      );
    }
    await restoreSupplierOrder(index);
    return {
      ok: false,
      status: 502,
      error: "Could not update the Shopify order status. Nothing was saved; please retry.",
    };
  }

  return { ok: true, row: claimed, result };
}
