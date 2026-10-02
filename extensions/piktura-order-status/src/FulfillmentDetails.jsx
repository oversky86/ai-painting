import "@shopify/ui-extensions/preact";
import { render } from "preact";
import { t } from "./i18n";

export default async () => {
  render(<Extension />, document.body);
};

function Extension() {
  return (
    <s-box padding="tight" background="subdued" borderRadius="base">
      <s-stack direction="block" gap="tight">
        <s-text type="strong">{t("fulfillmentHeading")}</s-text>
        <s-text size="small">{t("fulfillmentBody")}</s-text>
      </s-stack>
    </s-box>
  );
}
