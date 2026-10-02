import '@shopify/ui-extensions';

//@ts-ignore
declare module './src/ThankYouLine.jsx' {
  const shopify: import('@shopify/ui-extensions/purchase.thank-you.cart-line-item.render-after').Api;
  const globalThis: { shopify: typeof shopify };
}

//@ts-ignore
declare module './src/ThankYouBlock.jsx' {
  const shopify: import('@shopify/ui-extensions/purchase.thank-you.block.render').Api;
  const globalThis: { shopify: typeof shopify };
}

//@ts-ignore
declare module './src/CustomizationDisplay.jsx' {
  const shopify:
    | import('@shopify/ui-extensions/purchase.thank-you.cart-line-item.render-after').Api
    | import('@shopify/ui-extensions/purchase.thank-you.block.render').Api;
  const globalThis: { shopify: typeof shopify };
}
