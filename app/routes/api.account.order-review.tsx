import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";

/**
 * Legacy Customer Account UI extension endpoint.
 * Replaced by HMAC server-to-server /api/account/order-write for account-web.
 */
export const loader = async (_args: LoaderFunctionArgs) => {
  return Response.json(
    {
      ok: false,
      error: "Deprecated. Use /api/account/order-write with HMAC auth.",
    },
    { status: 410 },
  );
};

export const action = async (_args: ActionFunctionArgs) => {
  return Response.json(
    {
      ok: false,
      error: "Deprecated. Use /api/account/order-write with HMAC auth.",
    },
    { status: 410 },
  );
};
