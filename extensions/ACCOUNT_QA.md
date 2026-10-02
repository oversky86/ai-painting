# Account extensions — deploy & QA checklist

## Merchant setup (required once)

1. **New Customer Accounts** enabled in Shopify Admin → Settings → Customer accounts.
2. Create a storefront page with handle `account`, assign template **page.account-gate**.
   - Header / empty cart will link to this page when it exists; otherwise they fall back to `storefront_login_url`.
3. Deploy the app so CA UI extensions are available:
   ```bash
   cd app/ecommerce-pet-app
   shopify app deploy
   ```
4. In **Checkout and accounts editor**, mount:
   - Artwork workspace (`piktura-account-workspace`) in customer account menu / pages
   - Order review action (`piktura-account-order-action`)
   - Order index announcement + block
   - Profile block + addresses note
   - Order status line / block / payment / fulfillment (existing `piktura-order-status`)

## Dual-viewport checks

| Viewport | Width | What to verify |
| --- | --- | --- |
| Mobile | ≤768 (e.g. 390) | Account gate stacked CTAs; CA pages usable |
| Desktop | ≥1024 (e.g. 1440) | Gate row CTAs; workspace layout |
| Ultra-wide | ≥2560 / 3840 | Gate max-width does not over-stretch |

## End-to-end review flow

1. Place a custom portrait order with line attributes (`original_photo_url`, `painting_url`, `style`, `keywords`).
2. Open Order status → line customization card + progress block appear.
3. Order action menu → **Review portrait** opens order review full page (deep link with order id).
4. Approve or request modification → API writes `custom.review_status` only when the session customer owns the order.
5. Refresh review page → approved state persists (via `appMetafields`).

## Notes

- Order status targets use inline `extensionLanguage` translations (no `shopify.i18n`).
- Cross-extension navigation uses `extension://<handle>`; within-extension routes use `extension://` / `extension://orders`.
- Order review deep link format: `extension:piktura-account-order-review/customer-account.order.page.render/<orderId>/`
