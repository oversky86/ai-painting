import "@shopify/ui-extensions/preact";
import { render } from "preact";
import { CustomizationDisplay } from "./CustomizationDisplay.jsx";

export default function extension() {
  render(<Extension />, document.body);
}

function Extension() {
  const line = shopify.target.value;
  return <CustomizationDisplay attrs={line.attributes || []} />;
}
