import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { responseSummary } from '../src/zzshu-response-history.js';

test('preserves nested reasons and filters structured and echoed credentials', () => {
  const safe = responseSummary({ code: 401, message: 'token expired; opaque-session-secret; CVV=987',
    token: { accessToken: 'opaque-session-secret' }, data: { result_message: 'authentication failed',
      bank_card_no: '4242424242424242', payment_result: { status: 'failed', error: { reason: 'declined' } },
      verification: { client_secret: 'verify-secret' } } });
  assert.equal(safe.code, 401);
  assert.match(safe.message, /token expired/);
  assert.equal(safe.data.payment_result.error.reason, 'declined');
  for (const secret of ['opaque-session-secret', '987', '4242424242424242', 'verify-secret'])
    assert.equal(JSON.stringify(safe).includes(secret), false);
});

test('creation and every status response persist, survive restart and remain admin-only', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zzshu-response-history-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  process.env.ADMIN_TOKEN = 'fixture-admin-password';
  process.env.DATA_FILE = path.join(dir, 'orders.json');
  process.env.ZZSHU_DB_FILE = path.join(dir, 'zzshu.sqlite');
  process.env.ZZSHU_ENABLED = 'true';
  process.env.ZZSHU_API_KEY = 'fixture-api-secret';
  process.env.RECOVERY_ENCRYPTION_KEY = 'fixture-encryption-key';
  const { zzshuService: service } = await import('../src/zzshu-service.js');
  const { ZzshuStore } = await import('../src/zzshu-store.js');
  const { zzshuCredentialStore } = await import('../src/zzshu-credential-store.js');
  const { config } = await import('../src/config.js');
  config.zzshuBaseUrl = 'https://fixture.example.test';
  const verifySaved = zzshuCredentialStore.verifySaved;
  zzshuCredentialStore.verifySaved = async () => ({ ok: true, points: 10 });
  t.after(() => { zzshuCredentialStore.verifySaved = verifySaved; });
  await service.importCards({ text: '4242424242424242,12/40,987', source: 'fixture', maxSuccess: 5 });
  const [voucher] = service.createVouchers({ count: 1, source: 'fixture' });
  const session = JSON.stringify({ user: { id: 'user', email: 'user@example.test' }, account: { id: 'account', planType: 'free' },
    accessToken: 'access-secret', sessionToken: 'session-secret', expires: '2040-01-01T00:00:00Z' });
  const realFetch = globalThis.fetch;
  let mode = 'create';
  globalThis.fetch = async () => {
    if (mode === 'network') throw new Error('secret-network-message');
    if (mode === 'invalid') return { status: 502, json: async () => { throw new Error('HTML'); } };
    if (mode === 'rejected') return { ok: false, status: 401, json: async () => ({ code: 40107, message: 'API credential rejected' }) };
    return { ok: true, status: mode === 'create' ? 201 : 200, json: async () => ({ code: 0,
      message: mode === 'create' ? 'created access-secret session-secret fixture-api-secret 4242424242424242 CVV=987' : 'still processing',
      data: { order_no: 'up-1', card_key: 'query-secret', plan_type: 'plus', status: 'processing',
        token: { accessToken: 'returned-token-secret' }, payment_result: { status: 'pending', message: 'payment awaiting processing' } } }) };
  };
  t.after(() => { globalThis.fetch = realFetch; });
  const created = await service.confirm({ cardInfo: voucher.code, secretJsonText: session });
  assert.equal(created.ok, true);
  const id = created.data.orderId;
  for (const next of ['status', 'rejected', 'invalid', 'network']) { mode = next; await service.refresh(id); }
  globalThis.fetch = realFetch;
  const history = service.store.responseHistory(id);
  assert.equal(history.total, 5);
  assert.deepEqual(history.entries.map(entry => entry.result), ['network_error', 'invalid_response', 'rejected', 'accepted', 'accepted']);
  assert.equal(history.entries[2].code, 40107);
  assert.equal(history.entries[2].reasons.message, 'API credential rejected');
  for (const secret of ['access-secret', 'session-secret', 'fixture-api-secret', '4242424242424242', '987', 'returned-token-secret', 'secret-network-message'])
    assert.equal(JSON.stringify(history).includes(secret), false);
  assert.equal(JSON.stringify(created.data).includes('upstreamResponseHistory'), false);
  const reopened = new ZzshuStore(process.env.ZZSHU_DB_FILE);
  assert.equal(reopened.responseHistory(id).total, 5);
  reopened.db.close();
  // More than one page must remain accessible without deleting older reasons.
  for (let n = 0; n < 101; n++) service.store.recordResponse(id, 'status', { result: 'accepted', reasons: { message: `poll ${n}` } });
  const page = service.store.responseHistory(id);
  const older = service.store.responseHistory(id, page.nextBefore);
  assert.equal(page.entries.length, 100);
  assert.equal(older.entries.length, 6);
  assert.equal(new Set([...page.entries, ...older.entries].map(entry => entry.id)).size, 106);
  const { server } = await import('../src/server.js');
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const url = `${base}/api/admin/recoveries/${id}/responses`;
  assert.equal((await fetch(url)).status, 401);
  const login = await fetch(base + '/api/admin/login', { method: 'POST',
    headers: { Origin: 'https://www.gptc.cc', 'Content-Type': 'application/json', 'X-Admin-Request': '1' },
    body: JSON.stringify({ password: 'fixture-admin-password' }) });
  assert.equal(login.status, 200);
  const headers = { Cookie: login.headers.get('set-cookie').split(';')[0] };
  assert.equal((await fetch(url, { headers }).then(r => r.json())).data.total, 106);
  assert.equal((await fetch(url + '?before=invalid', { headers })).status, 400);
  const detail = await fetch(`${base}/api/admin/recoveries/${id}`, { headers }).then(r => r.json());
  assert.equal(detail.data.upstreamResponseHistory.total, 106);
  const html = await fetch(base + '/admin/recoveries', { headers }).then(r => r.text());
  assert.match(html, /ZZS 返回历史/);
  for (const match of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)) new vm.Script(match[1]);
});
