# Work Rules

## Purchase Link Lock

The purchase-card URL is protected.

- Purchase buttons, card-buy CTAs, and purchase-related constants must keep using `https://fe.dtyuedan.cn/shop/jiage`.
- Activation/recharge links may use `https://987ai.vip/recharge`, but never use that URL for a purchase CTA.
- Do not modify purchase button URLs, `BUY_URL` / `PURCHASE_URL` constants, or purchase-link-lock files unless the user explicitly confirms in the same turn with the replacement URL.
- If the request is about activation, recharge, providers, VPS, or deployment, do not infer any purchase-link change.
- Before committing or pushing, run `node scripts/check-purchase-link-lock.mjs`.
