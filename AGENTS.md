# Work Rules

## Purchase Link Lock

Purchase-card URLs are protected, but they are not permanently tied to one provider. The current allowed purchase URL list lives in `purchase-link-lock.json`.

- Purchase buttons, card-buy CTAs, and purchase-related constants must use one of the configured `purchaseUrls`.
- Activation/recharge links may change independently, but never use an activation/recharge URL for a purchase CTA.
- Do not modify purchase button URLs, `BUY_URL` / `PURCHASE_URL` constants, `purchase-link-lock.json`, or purchase-link-lock files unless the user explicitly confirms in the same turn with the replacement purchase URL.
- If the request is about activation, recharge, providers, VPS, or deployment, do not infer any purchase-link change.
- When the user confirms a new purchase provider, update `purchase-link-lock.json` and all purchase CTAs together.
- Before committing or pushing, run `node scripts/check-purchase-link-lock.mjs`.
