import test from 'node:test';
import assert from 'node:assert/strict';
import relay from '../worker/zzshu-relay.js';

const url = 'https://relay.example/api/v1/third-party/orders/status';
const env = { GPTC_RELAY_TOKEN: 'test-relay-token' };

test('relay rejects unsupported routes and unauthenticated order requests', async () => {
  assert.equal((await relay.fetch(new Request('https://relay.example/other'), env)).status, 404);
  assert.equal((await relay.fetch(new Request(url, { method: 'POST' }), env)).status, 401);
  assert.equal((await relay.fetch(new Request(`${url}?next=other`, { method: 'POST' }), env)).status, 404);
});

test('relay sends a single status query to the documented upstream path', async () => {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (target, options) => {
    calls.push({ target, options });
    return new Response(JSON.stringify({ code: 0, data: { status: 'processing' } }),
      { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  try {
    const response = await relay.fetch(new Request(url, {
      method: 'POST', headers: { 'X-GPTC-Relay-Token': env.GPTC_RELAY_TOKEN,
        'X-API-Key': 'fake-upstream-key', 'Content-Type': 'application/json' },
      body: JSON.stringify({ cardKey: 'fake-order' })
    }), env);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].target, 'https://card.zzshu.pro/api/v1/third-party/orders/status');
    assert.equal(calls[0].options.method, 'POST');
    assert.equal(calls[0].options.headers['X-API-Key'], 'fake-upstream-key');
    assert.equal(calls[0].options.headers['X-GPTC-Relay-Token'], undefined);
    assert.deepEqual(JSON.parse(calls[0].options.body), { cardKey: 'fake-order' });
  } finally { globalThis.fetch = original; }
});

test('relay keeps unknown upstream failures distinct from payment failure', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('network unavailable'); };
  try {
    const response = await relay.fetch(new Request(url, {
      method: 'POST', headers: { 'X-GPTC-Relay-Token': env.GPTC_RELAY_TOKEN, 'X-API-Key': 'fake-upstream-key' },
      body: '{}'
    }), env);
    assert.equal(response.status, 502);
    assert.equal((await response.json()).code, 502);
  } finally { globalThis.fetch = original; }
});

test('backend adds the relay token only to ZZS requests', async () => {
  const before = process.env.ZZSHU_RELAY_TOKEN;
  process.env.ZZSHU_RELAY_TOKEN = 'test-relay-token';
  try {
    const { zzshuRequestHeaders } = await import('../src/zzshu-relay.js');
    assert.deepEqual(zzshuRequestHeaders({ 'X-API-Key': 'fake-upstream-key' }),
      { 'X-API-Key': 'fake-upstream-key', 'X-GPTC-Relay-Token': 'test-relay-token' });
  } finally {
    if (before === undefined) delete process.env.ZZSHU_RELAY_TOKEN;
    else process.env.ZZSHU_RELAY_TOKEN = before;
  }
});
