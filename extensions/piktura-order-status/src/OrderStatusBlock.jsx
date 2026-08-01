import "@shopify/ui-extensions/preact";
import { render } from "preact";
import { t } from "./i18n";

export default async () => {
  render(<Extension />, document.body);
};

/** Period 1 Vercel URL; update when ACCOUNT_WEB_URL / subdomain changes. */
const ACCOUNT_WEB_URL = "https://ai-painting-account.vercel.app";

function reviewHref(orderId, shopDomain) {
  if (!orderId) return undefined;
  const numeric = String(orderId).replace(/\D/g, "") || orderId;
  const url = new URL(`${ACCOUNT_WEB_URL}/orders`);
  url.searchParams.set("review", String(orderId));
  if (shopDomain) url.searchParams.set("shop", shopDomain);
  url.hash = numeric;
  return url.toString();
}

function Extension() {
  const orderId = shopify.order?.value?.id;
  const shopDomain =
    shopify.shop?.myshopifyDomain ||
    shopify.shop?.value?.myshopifyDomain ||
    undefined;
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
