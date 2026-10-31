import "@shopify/ui-extensions/preact";
import { render } from "preact";
import { t } from "./i18n";

export default async () => {
  render(<Extension />, document.body);
};

const ACCOUNT_WEB_URL = "https://orders.viewbrush.com";

function publicShopKey(shopDomain) {
  const host = String(shopDomain || "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .split("/")[0];
  if (!host) return undefined;
  if (
    host === "6hcr01-9t.myshopify.com" ||
    host === "view-brush.myshopify.com" ||
    host === "viewbrush.com" ||
    host === "www.viewbrush.com"
  ) {
    return "prod";
  }
  if (host === "e-commerce-dev-v6yidmlw.myshopify.com") return "dev";
  return undefined;
}

function currentShopDomain() {
  const shop = shopify.shop?.value || shopify.shop || {};
  return shop.myshopifyDomain || shop.storefrontUrl || "";
}

function reviewHref(orderId, shopDomain) {
  if (!orderId) return undefined;
  const numeric = String(orderId).replace(/\D/g, "") || orderId;
  const url = new URL(`${ACCOUNT_WEB_URL}/orders`);
  url.searchParams.set("review", String(orderId));
  url.searchParams.set("shop", publicShopKey(shopDomain) || "prod");
  url.hash = numeric;
  return url.toString();
}

function Extension() {
  const orderId = shopify.order?.value?.id;
  const shopDomain = currentShopDomain();
  const href = reviewHref(orderId, shopDomain);

  return (
    <s-box padding="base" background="subdued" borderRadius="base">
      <s-stack direction="block" gap="tight">
        <s-heading>{t("progressHeading")}</s-heading>
        <s-text>{t("progressBody")}</s-text>
        {href ? (
          <s-button href={href} target="_blank">
            {t("reviewPortrait")}
          </s-button>
        ) : (
          <s-button disabled>{t("reviewPortrait")}</s-button>
        )}
      </s-stack>
    </s-box>
  );
}
