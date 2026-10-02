import "@shopify/ui-extensions/preact";
import { render } from "preact";
import { useState } from "preact/hooks";
import { t } from "./i18n";

export default function extension() {
  render(<Extension />, document.body);
}

function Extension() {
  const line = shopify.target.value;
  const attrs = line.attributes || [];

  const get = (k) => {
    const hidden = attrs.find((a) => a.key === `_${k}`);
    if (hidden?.value) return hidden.value;
    const found = attrs.find((a) => a.key === k);
    return found ? found.value : undefined;
  };

  const photo = get("original_photo_url");
  const painting = get("painting_url");
  const style = get("style");
  const keywords = get("keywords");
  const [modal, setModal] = useState(null);

  if (!photo && !painting && !style) return null;

  return (
    <>
      <s-box padding="tight" background="subdued" borderRadius="base">
        <s-stack gap="tight">
          <s-text type="strong" size="small">
            {t("customizationTitle")}
          </s-text>
          {style && (
            <s-text size="small">
              {t("styleLabel")}: {style}
            </s-text>
          )}
          {keywords && (
            <s-text size="small">
              {t("keywordsLabel")}: {keywords}
            </s-text>
          )}
          <s-stack direction="inline" gap="base">
            {photo && (
              <s-button variant="tertiary" onClick={() => setModal("photo")}>
                <s-image
                  src={photo}
                  alt={t("originalPhoto")}
                  aspectRatio="1"
                  objectFit="cover"
                />
              </s-button>
            )}
            {painting && (
              <s-button variant="tertiary" onClick={() => setModal("art")}>
                <s-image
                  src={painting}
                  alt={t("generatedPainting")}
                  aspectRatio="1"
                  objectFit="cover"
                />
              </s-button>
            )}
          </s-stack>
        </s-stack>
      </s-box>
      {modal === "photo" && photo && (
        <s-modal
          id="modal-photo"
          heading={t("originalPhotoFull")}
          onModalClose={() => setModal(null)}
        >
          <s-image src={photo} alt={t("originalPhoto")} />
        </s-modal>
      )}
      {modal === "art" && painting && (
        <s-modal
          id="modal-art"
          heading={t("generatedPaintingFull")}
          onModalClose={() => setModal(null)}
        >
          <s-image src={painting} alt={t("generatedPainting")} />
        </s-modal>
      )}
    </>
  );
}
