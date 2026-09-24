import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ZzshuCredentialStore } from "../src/zzshu-credential-store.js";

test("ZZS credential is verified before one-time encrypted runtime storage", async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "zzshu-credential-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const apiKey = "fixture-zzshu-api-key";
  let expectedKey = apiKey;
  let requests = 0;
  const store = new ZzshuCredentialStore({
    file: path.join(directory, "zzshu-api-key.json"),
    encryptionKey: () => "fixture-encryption-key",
    environmentKey: () => "",
    baseUrl: () => "https://zzshu.example.test",
    timeoutMs: () => 15000,
    fetchImpl: async (url, options) => {
      requests++;
      assert.equal(String(url), "https://zzshu.example.test/api/v1/third-party/user");
      assert.equal(options.method, "GET");
      assert.equal(options.headers["X-API-Key"], expectedKey);
      return { ok: true, json: async () => ({ code: 0, data: { points: 9, token: "must-not-return" } }) };
    }
  });
  assert.equal(store.status().configured, false);
  assert.equal(store.status().canConfigure, true);
  assert.equal(store.status().storageReady, true);
  const saved = await store.verifyAndSave(apiKey);
  assert.deepEqual(saved, { ok: true, points: 9 });
  assert.equal(requests, 1);
  const persisted = fs.readFileSync(path.join(directory, "zzshu-api-key.json"), "utf8");
  assert.equal(persisted.includes(apiKey), false);
  assert.equal(fs.statSync(path.join(directory, "zzshu-api-key.json")).mode & 0o777, 0o600);
  assert.equal(store.key(), apiKey);
  assert.equal(store.status().source, "runtime-secret");
  assert.deepEqual(await store.verifySaved(), { ok: true, points: 9 });
  assert.equal(requests, 2);
  const blocked = await store.verifyAndSave("different-fixture-key");
  assert.equal(blocked.status, 409);
  assert.equal(requests, 2);
  expectedKey = "replacement-fixture-key";
  assert.deepEqual(await store.verifyAndSave(expectedKey, { replace: true }), { ok: true, points: 9 });
  assert.equal(store.key(), expectedKey);
  assert.equal(requests, 3);
});

test("invalid ZZS key is never persisted and only the verification endpoint is called", async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "zzshu-credential-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, "zzshu-api-key.json");
  const store = new ZzshuCredentialStore({
    file,
    encryptionKey: () => "fixture-encryption-key",
    environmentKey: () => "",
    baseUrl: () => "https://zzshu.example.test",
    timeoutMs: () => 15000,
    fetchImpl: async (_url, options) => {
      assert.equal(options.method, "GET");
      return { ok: false, json: async () => ({ code: 40107 }) };
    }
  });
  const result = await store.verifyAndSave("wrong-fixture-key");
  assert.equal(result.ok, false);
  assert.equal(fs.existsSync(file), false);
  assert.equal((await store.verifySaved()).status, 503);
});

test("ZZS deployment Key can be replaced from admin and remains active after restart", async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "zzshu-override-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const options = { file: path.join(directory, "key.json"), encryptionKey: () => "fixture-encryption-key",
    environmentKey: () => "deployment-key", baseUrl: () => "https://zzshu.example.test", timeoutMs: () => 15000,
    fetchImpl: async (_url, request) => {
      assert.equal(request.headers["X-API-Key"], "replacement-key");
      return { ok: true, json: async () => ({ code: 0, data: { points: 1 } }) };
    } };
  const store = new ZzshuCredentialStore(options);
  assert.equal(store.status().canConfigure, true);
  assert.equal(store.key(), "deployment-key");
  assert.equal((await store.verifyAndSave("replacement-key", { replace: true })).ok, true);
  assert.equal(new ZzshuCredentialStore(options).key(), "replacement-key");
});
