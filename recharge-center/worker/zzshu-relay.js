// Dedicated GPTC -> ZZS network relay. No order state or credentials are stored here.
const UPSTREAM = 'https://card.zzshu.pro';
const ROUTES = new Map([
  ['/api/v1/third-party/user', 'GET'],
  ['/api/v1/third-party/orders/history', 'POST'],
  ['/api/v1/third-party/orders/direct', 'POST'],
  ['/api/v1/third-party/orders/status', 'POST']
]);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/probe') {
      try {
        const response = await fetch(`${UPSTREAM}/api/v1/third-party/user`, {
          headers: { 'X-API-Key': 'GPTC-PROBE-INVALID-KEY', Accept: 'application/json' },
          redirect: 'manual'
        });
        let body = null;
        try { body = await response.json(); } catch {}
        return Response.json({ status: response.status, code: Number.isInteger(body?.code) ? body.code : null,
          ray: response.headers.get('cf-ray') });
      } catch {
        return Response.json({ error: 'upstream_unreachable' }, { status: 502 });
      }
    }
    if (ROUTES.get(url.pathname) !== request.method || url.search) return new Response('Not found', { status: 404 });
    const expected = env.GPTC_RELAY_TOKEN;
    const supplied = request.headers.get('X-GPTC-Relay-Token');
    if (!expected || !supplied || supplied !== expected) return new Response('Unauthorized', { status: 401 });
    const apiKey = request.headers.get('X-API-Key');
    if (!apiKey || apiKey.length > 512) return new Response('Missing API key', { status: 400 });
    const length = Number(request.headers.get('content-length') || 0);
    if (length > 256 * 1024) return new Response('Payload too large', { status: 413 });
    let body;
    if (request.method === 'POST') {
      body = await request.text();
      if (body.length > 256 * 1024) return new Response('Payload too large', { status: 413 });
    }
    try {
      const upstream = await fetch(`${UPSTREAM}${url.pathname}`, {
        method: request.method,
        headers: { 'X-API-Key': apiKey, Accept: 'application/json',
          ...(request.method === 'POST' ? { 'Content-Type': 'application/json' } : {}) },
        body,
        redirect: 'manual'
      });
      return new Response(upstream.body, { status: upstream.status,
        headers: { 'Content-Type': upstream.headers.get('Content-Type') || 'application/json',
          'Cache-Control': 'no-store', ...(upstream.headers.get('cf-ray') ? { 'X-ZZS-CF-Ray': upstream.headers.get('cf-ray') } : {}) } });
    } catch {
      return Response.json({ code: 502, message: 'ZZS upstream unavailable' }, { status: 502,
        headers: { 'Cache-Control': 'no-store' } });
    }
  }
};
