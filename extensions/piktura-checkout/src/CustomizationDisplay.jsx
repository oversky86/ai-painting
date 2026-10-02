import { useState } from "preact/hooks";

/**
 * Shared component that renders customization info (original photo, painting, style)
 * with thumbnail images and a modal lightbox for full-size viewing.
 *
 * @param {{ attrs: Array<{key: string, value: string}> }} props
 */
export function CustomizationDisplay({ attrs }) {
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
          <s-text type="strong" size="small">Your Customization</s-text>
          {style && <s-text size="small">Style: {style}</s-text>}
          {keywords && <s-text size="small">Keywords: {keywords}</s-text>}
          <s-stack direction="inline" gap="base">
            {photo && (
              <s-button variant="tertiary" onClick={() => setModal("photo")}>
                <s-image
                  src={photo}
                  alt="Original photo"
                  aspectRatio="1"
                  objectFit="cover"
                />
              </s-button>
            )}
            {painting && (
              <s-button variant="tertiary" onClick={() => setModal("art")}>
                <s-image
                  src={painting}
                  alt="Generated painting"
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
          heading="Original Photo"
          onModalClose={() => setModal(null)}
        >
          <s-image src={photo} alt="Original photo full size" />
        </s-modal>
      )}
      {modal === "art" && painting && (
        <s-modal
          id="modal-art"
          heading="Generated Painting"
          onModalClose={() => setModal(null)}
        >
          <s-image src={painting} alt="Generated painting full size" />
        </s-modal>
      )}
    </>
  );
}
