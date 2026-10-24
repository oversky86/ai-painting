import { createHmac } from "node:crypto";

const CUSTOMER_ERROR = "The remaining balance could not be collected. Please try again.";

/**
 * Asks the selling-plan app to capture the unpaid deposit balance.
 * Orders without a vaulted card are left unchanged.
 */
export async function chargeRemainingBalance(shop: string, orderGid: string): Promise<void> {
  const secret = process.env.BALANCE_CHARGE_SECRET?.trim();
  const url = (process.env.SELLING_PLAN_URL || "https://custom-selling-plan.vercel.app").replace(
    /\/$/,
    "",
  );
  if (!secret) {
    console.error("[balance-charge] BALANCE_CHARGE_SECRET is not set");
    throw new Error(CUSTOMER_ERROR);
  }

  const body = JSON.stringify({ shop, orderId: orderGid });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
  let response: Response;
  try {
    response = await fetch(`${url}/api/balance-charge`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Balance-Timestamp": timestamp,
        "X-Balance-Signature": signature,
      },
      body,
      signal: AbortSignal.timeout(20_000),
    });
  } catch (error) {
    console.error("[balance-charge] request failed", error);
    throw new Error(CUSTOMER_ERROR);
  }

  const json = (await response.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
  if (!response.ok || !json?.ok) {
    console.error("[balance-charge] rejected", response.status, json?.error);
    throw new Error(CUSTOMER_ERROR);
  }
}
