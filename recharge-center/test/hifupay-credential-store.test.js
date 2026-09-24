import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { HifupayCredentialStore } from "../src/hifupay-credential-store.js";

test("嗨付 API Key 验证通过后持久化且管理响应不返回明文", async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "hifupay-credential-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const apiKey = "fixture-hifupay-api-key";
  let expectedKey = apiKey;
  let requests = 0;
  const store = new HifupayCredentialStore({
    file: path.join(directory, "hifupay-api-key.json"), encryptionKey: () => "fixture-encryption-key", environmentKey: () => "", baseUrl: () => "https://hifupay.example.test",
    fetchImpl: async (url, options) => { requests++; assert.equal(String(url), "https://hifupay.example.test/api/hfp/login"); assert.deepEqual(JSON.parse(options.body), { apiKey: expectedKey, platform: "haifupaytop" }); return { ok: true, json: async () => ({ success: true, apiKey: "temporary-session-key" }) }; }
  });
  assert.deepEqual(store.status(), { configured: false, source: "", canConfigure: true, storageReady: true });
  assert.deepEqual(await store.verifyAndSave(apiKey), { ok: true });
  assert.equal(requests, 1);
  const persisted = fs.readFileSync(store.file, "utf8");
  assert.equal(persisted.includes(apiKey), false);
  assert.equal(store.key(), apiKey);
  assert.equal(store.status().source, "runtime-secret");
  assert.deepEqual(await store.verifySaved(), { ok: true });
  assert.equal(requests, 2);
  assert.equal((await store.verifyAndSave("different-key")).status, 409);
  assert.equal(requests, 2);
  expectedKey = "replacement-key";
  assert.deepEqual(await store.verifyAndSave(expectedKey, { replace: true }), { ok: true });
  assert.equal(store.key(), expectedKey);
  assert.equal(requests, 3);
});

test("嗨付拒绝的 API Key 不写入配置", async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "hifupay-credential-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, "key.json");
  const store = new HifupayCredentialStore({ file, encryptionKey: () => "fixture-encryption-key", environmentKey: () => "", baseUrl: () => "https://hifupay.example.test", fetchImpl: async () => ({ ok: false, json: async () => ({ success: false }) }) });
  assert.equal((await store.verifyAndSave("wrong-key")).ok, false);
  assert.equal(fs.existsSync(file), false);
});

test("嗨付部署 Key 可在后台验证后替换并在重启后保持", async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "hifupay-override-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const options = { file: path.join(directory, "key.json"), encryptionKey: () => "fixture-encryption-key",
    environmentKey: () => "deployment-key", baseUrl: () => "https://hifupay.example.test",
    fetchImpl: async (_url, request) => {
      assert.equal(JSON.parse(request.body).apiKey, "replacement-key");
      return { ok: true, json: async () => ({ success: true, apiKey: "session-key" }) };
    } };
  const store = new HifupayCredentialStore(options);
  assert.equal(store.status().canConfigure, true);
  assert.equal(store.key(), "deployment-key");
  assert.equal((await store.verifyAndSave("replacement-key", { replace: true })).ok, true);
  assert.equal(new HifupayCredentialStore(options).key(), "replacement-key");
});
