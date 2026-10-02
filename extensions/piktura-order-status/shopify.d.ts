import '@shopify/ui-extensions';

//@ts-ignore
declare module './src/OrderStatusLine.jsx' {
  const shopify: import('@shopify/ui-extensions/customer-account.order-status.cart-line-item.render-after').Api;
  const globalThis: { shopify: typeof shopify };
}

//@ts-ignore
declare module './src/OrderStatusBlock.jsx' {
  const shopify: import('@shopify/ui-extensions/customer-account.order-status.block.render').Api;
  const globalThis: { shopify: typeof shopify };
}

//@ts-ignore
declare module './src/PaymentDetails.jsx' {
  const shopify: import('@shopify/ui-extensions/customer-account.order-status.payment-details.render-after').Api;
  const globalThis: { shopify: typeof shopify };
}

//@ts-ignore
declare module './src/FulfillmentDetails.jsx' {
  const shopify: import('@shopify/ui-extensions/customer-account.order-status.fulfillment-details.render-after').Api;
  const globalThis: { shopify: typeof shopify };
}

//@ts-ignore
declare module './src/i18n.js' {
  const shopify:
    | import('@shopify/ui-extensions/customer-account.order-status.cart-line-item.render-after').Api
    | import('@shopify/ui-extensions/customer-account.order-status.block.render').Api
    | import('@shopify/ui-extensions/customer-account.order-status.payment-details.render-after').Api
    | import('@shopify/ui-extensions/customer-account.order-status.fulfillment-details.render-after').Api;
  const globalThis: { shopify: typeof shopify };
}
