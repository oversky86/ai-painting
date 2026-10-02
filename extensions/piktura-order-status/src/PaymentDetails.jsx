import "@shopify/ui-extensions/preact";
import { render } from "preact";
import { t } from "./i18n";

export default async () => {
  render(<Extension />, document.body);
};

function Extension() {
  const order = shopify.order?.value;
  const financial = order?.financialStatus || "PENDING";

  return (
    <s-box padding="tight" background="subdued" borderRadius="base">
      <s-stack direction="block" gap="tight">
        <s-text type="strong">{t("paymentHeading")}</s-text>
        <s-badge>{String(financial)}</s-badge>
        <s-text size="small">{t("paymentBody")}</s-text>
      </s-stack>
    </s-box>
  );
}
