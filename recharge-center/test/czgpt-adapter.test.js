import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", chunk => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sendJson(res, status, value) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(value));
}

test("CZGPT adapter verifies, starts and polls a GPT Pro task", async t => {
  let pollCount = 0;
  const upstream = http.createServer(async (req, res) => {
    if (req.method === "POST" && req.url === "/api/v1/kami/status") {
      const code = await readBody(req);
      assert.equal(req.headers["content-type"], "text/plain");
      sendJson(res, 200, [{
        code,
        status: "unused",
        is_distributed: true,
        type: "gpt_pro_20x",
        bound_email: null,
        used_at: null
      }]);
      return;
    }

    if (req.method === "POST" && req.url === "/api/v1/kami/use") {
      const payload = JSON.parse(await readBody(req));
      assert.equal(payload.code, "G20XTESTCODE1234");
      assert.equal(payload.session.user.email, "test@example.com");
      assert.equal(payload.session.account.id, "account_test");
      assert.equal(payload.session.accessToken, "token_test");
      sendJson(res, 200, {
        task_id: "task-test",
        code: payload.code,
        status: "bound",
        message: "任务已创建"
      });
      return;
    }

    if (req.method === "GET" && req.url === "/api/v1/kami/task/task-test") {
      pollCount += 1;
      sendJson(res, 200, {
        id: "task-test",
        status: pollCount === 1 ? "working" : "succeeded",
        message: pollCount === 1 ? "处理中" : "充值成功"
      });
      return;
    }

    sendJson(res, 404, { detail: "Not found" });
  });

  await new Promise(resolve => upstream.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => upstream.close(resolve)));
  const address = upstream.address();
  process.env.RESELLER_BASE_URL = `http://127.0.0.1:${address.port}`;

  const { czgptAdapter } = await import(`../src/providers/czgpt-adapter.js?test=${Date.now()}`);
  const verified = await czgptAdapter.verifyCard({ cardInfo: "G20XTESTCODE1234" });
  assert.equal(verified.ok, true);
  assert.equal(verified.data.cardType, "gpt_pro_20x");

  const started = await czgptAdapter.startRecharge({
    cardInfo: "G20XTESTCODE1234",
    fullAuthData: {
      user: { id: "user_test", email: "test@example.com" },
      account: { id: "account_test", planType: "free" },
      accessToken: "token_test"
    }
  });
  assert.equal(started.ok, true);
  assert.equal(started.data.taskId, "task-test");

  const working = await czgptAdapter.queryTaskStatus({ taskId: "task-test" });
  assert.equal(working.data.status, "processing");

  const succeeded = await czgptAdapter.queryTaskStatus({ taskId: "task-test" });
  assert.equal(succeeded.data.status, "success");
});
