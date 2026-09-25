import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { normalizeZzshuProxy, ZzshuProxyStore, zzshuFetch } from "../src/zzshu-proxy.js";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "gptc-zzshu-proxy-"));
after(() => fs.rmSync(directory, { recursive: true, force: true }));

test("ZZS proxy URI is constrained and stored only as ciphertext", () => {
  assert.equal(normalizeZzshuProxy("https://example.com/subscription"), "");
  assert.equal(normalizeZzshuProxy("socks5://user:pass@127.0.0.1:1080"), "socks5h://user:pass@127.0.0.1:1080");
  assert.equal(normalizeZzshuProxy("http://proxy.local:8080"), "http://proxy.local:8080/");
  const file = path.join(directory, "proxy.json");
  const store = new ZzshuProxyStore({ file, encryptionKey: () => "test-only-encryption-key" });
  assert.deepEqual(store.status(), { configured: false, storageReady: true });
  assert.equal(store.save("socks5://user:pass@127.0.0.1:1080").ok, true);
  assert.equal(store.url(), "socks5h://user:pass@127.0.0.1:1080");
  assert.equal(fs.readFileSync(file, "utf8").includes("user:pass"), false);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(store.save("https://example.com/subscription").ok, false);
  assert.equal(store.url(), "socks5h://user:pass@127.0.0.1:1080");
  fs.writeFileSync(file, "broken", { mode: 0o600 });
  assert.equal(store.status().storageReady, false);
});

test("ZZS proxy transport uses CONNECT and never bypasses a failed configured proxy", async () => {
  const proxy = http.createServer();
  let requests = 0;
  proxy.on("connect", (_request, socket) => {
    requests++;
    socket.end("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n");
  });
  await new Promise(resolve => proxy.listen(0, "127.0.0.1", resolve));
  try {
    const address = proxy.address();
    const response = await zzshuFetch("https://card.zzshu.pro/api/v1/third-party/user", {
      method: "GET", signal: AbortSignal.timeout(2000)
    }, `http://127.0.0.1:${address.port}`);
    assert.equal(response.status, 502);
    assert.equal(requests, 1);
  } finally { await new Promise(resolve => proxy.close(resolve)); }
});
