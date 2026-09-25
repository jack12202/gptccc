# ZZS connection relay

The GPTC production host currently receives Cloudflare HTTP 520 when it connects directly to `card.zzshu.pro`. The Cloudflare Worker at `gptc-zzs-connectivity-probe.zjk12202.workers.dev` successfully reaches the documented ZZS API from the same host. This Worker forwards only the four documented GPTC routes. It does not store order state or the ZZS API Key.

Deploy `zzshu-relay.js` as that Worker and set its encrypted secret `GPTC_RELAY_TOKEN`. Set the identical value as the repository Actions secret `ZZSHU_RELAY_TOKEN`. The backend deploy script then configures `ZZSHU_BASE_URL` to the Worker and adds the relay token to ZZS requests. The existing encrypted ZZS Key remains on the backend and still goes to ZZS in `X-API-Key`.

Read-only checks after deployment:

1. `GET /probe` on the Worker should report upstream HTTP 401/code 40107 for the dummy Key. If it reports 520 or 502, the path is unavailable.
2. An unauthenticated request to a ZZS route should return HTTP 401 from the Worker.
3. The GPTC admin connection check should return the stored Key's point balance without replacing the Key or creating an order.

Do not infer recharge success from connectivity alone. A real order still needs the existing status reconciliation flow; never submit a new order to test this relay.
