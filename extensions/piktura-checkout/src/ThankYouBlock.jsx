import "@shopify/ui-extensions/preact";
import { render } from "preact";
import { CustomizationDisplay } from "./CustomizationDisplay.jsx";

export default function extension() {
  render(<Extension />, document.body);
}

function Extension() {
  const lines = shopify.lines.value;
  const customLines = lines.filter((l) =>
    l.attributes?.some((a) =>
      a.key === "original_photo_url" ||
      a.key === "_original_photo_url" ||
      a.key === "painting_url" ||
      a.key === "_painting_url" ||
      a.key === "style"
    )
  );

  if (customLines.length === 0) return null;

  return (
    <s-stack gap="base">
      {customLines.map((line) => (
        <CustomizationDisplay key={line.id} attrs={line.attributes || []} />
      ))}
    </s-stack>
  );
}
