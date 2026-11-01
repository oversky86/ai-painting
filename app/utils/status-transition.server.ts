import { canTransition, type BusinessStatus } from "./business-status.server";
import {
  getOrderBusinessStatus,
  setOrderBusinessStatus,
} from "./shopify-order.server";
import {
  applySupplierTransition,
  reconcileSupplierOrder,
  revertSupplierTransition,
  type SupplierOrderRow,
  type TransitionBundle,
} from "./supplier-store.server";

type AdminClient = Parameters<typeof setOrderBusinessStatus>[0];

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
 * Commits the database change first, then talks to Shopify.
 * If Shopify does not reach `next`, the database write is reverted.
 * An irreversible Shopify side effect (a created fulfillment) is kept.
 */
export async function runTransition<T = undefined>(input: {
  admin: AdminClient;
  ownerId: string;
  index: SupplierOrderRow;
  current: BusinessStatus;
  next: BusinessStatus;
  bundle: TransitionBundle;
  /** Shopify work that cannot sit inside the database transaction. */
  apply?: () => Promise<T>;
  /** The Shopify side effect cannot be undone. Keep the database row if it succeeded. */
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

  const applied = await applySupplierTransition({
    order: index,
    fromStatus: current,
    toStatus: next,
    bundle: input.bundle,
  });
  if (!applied) {
    return { ok: false, status: 409, error: BUSY_MESSAGE };
  }

  const undoDatabase = async () => {
    await revertSupplierTransition({
      orderRowId: index.id,
      fromStatus: current,
      toStatus: next,
      eventId: applied.eventId,
      portraitVersionId: applied.portraitVersionId,
      modificationRequestId: applied.modificationRequestId,
    }).catch((err) => console.error("[transition] revert failed", ownerId, err));
  };

  let result = undefined as T;
  let shopifySideEffectDone = false;
  try {
    if (input.apply) {
      result = await input.apply();
      shopifySideEffectDone = true;
    }
  } catch (err) {
    await undoDatabase();
    if (err instanceof TransitionAbort) {
      return { ok: false, status: err.status, error: err.message };
    }
    throw err;
  }

  try {
    await setOrderBusinessStatus(
      admin,
      index.shop,
      ownerId,
      next,
      next === "portrait_review" && input.bundle.portrait
        ? String(input.bundle.portrait.versionNumber)
        : null,
    );
  } catch (err) {
    console.error("[transition] metafield write failed", ownerId, next, err);
    const landed = await getOrderBusinessStatus(admin, ownerId).catch(() => null);
    if (landed === next) return { ok: true, row: applied.order, result };
    if (input.irreversible && shopifySideEffectDone) {
      return {
        ok: false,
        status: 502,
        error:
          "Shopify accepted the change, but the order status could not be saved. Refresh the order; it will catch up on its own.",
      };
    }
    await undoDatabase();
    return {
      ok: false,
      status: 502,
      error: "Could not update the Shopify order status. Nothing was saved; please retry.",
    };
  }

  return { ok: true, row: applied.order, result };
}
