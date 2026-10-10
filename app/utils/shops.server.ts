/** Shop identity shared by the dev store and the new live store. */

export const DEV_SHOP = "e-commerce-dev-v6yidmlw.myshopify.com";
export const LIVE_SHOP = "6hcr01-9t.myshopify.com";

const RETIRED_SHOPS = new Set(["w4yzmt-vv.myshopify.com"]);

const LIVE_HOSTS = new Set([
  LIVE_SHOP,
  "view-brush.myshopify.com",
  "viewbrush.com",
  "www.viewbrush.com",
]);

/** Domains that may hold the live app's offline session. */
export const LIVE_SESSION_SHOPS = [LIVE_SHOP, "view-brush.myshopify.com"];

export function normalizeShopHost(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/$/, "")
    .split("/")[0];
}

export function isLiveShop(input: string): boolean {
  return LIVE_HOSTS.has(normalizeShopHost(input));
}

export function isRetiredShop(input: string): boolean {
  return RETIRED_SHOPS.has(normalizeShopHost(input));
}

/** Map every live hostname onto the Shopify default domain used as the data key. */
export function canonicalShop(input: string): string {
  const host = normalizeShopHost(input);
  if (LIVE_HOSTS.has(host)) return LIVE_SHOP;
  return host;
}
