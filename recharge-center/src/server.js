import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { config } from "./config.js";
import { rechargeService } from "./recharge-service.js";
import { readJsonBody, sendJson } from "./utils.js";

const frontendCandidates = [
  config.frontendFile,
  path.join(config.rootDir, "充值中心原型.html"),
  path.join(config.rootDir, "..", "activate", "index.html")
].filter(Boolean);

function resolveFrontendPath() {
  return frontendCandidates.find(candidate => fs.existsSync(candidate)) || frontendCandidates[0];
}

function servePrototype(res) {
  const frontendPath = resolveFrontendPath();
  const html = fs.readFileSync(frontendPath, "utf8");
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(html);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/activate")) {
      servePrototype(res);
      return;
    }

    if (req.method === "GET" && url.pathname === "/health") {
      sendJson(res, 200, { ok: true, service: "recharge-center-mvp" });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/recharge/verify-card") {
      const body = await readJsonBody(req);
      const result = await rechargeService.verifyCard(body.cardInfo);
      sendJson(res, result.status, result.ok ? { success: true, upstream: result.upstream.data } : { success: false, message: result.message || "验卡失败。", upstream: result.upstream?.data });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/recharge/parse-secret") {
      const body = await readJsonBody(req);
      const result = rechargeService.parseSecret(body.secretJsonText);
      sendJson(res, result.status, result.ok ? { success: true, data: result.data } : { success: false, message: result.message });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/recharge/confirm") {
      const body = await readJsonBody(req);
      const result = await rechargeService.confirmRecharge(body);
      sendJson(res, result.status, result.ok ? { success: true, data: result.data } : { success: false, message: result.message || "充值提交失败。", data: result.data });
      return;
    }

    if (req.method === "GET" && url.pathname.startsWith("/api/recharge/status/")) {
      const orderId = decodeURIComponent(url.pathname.replace("/api/recharge/status/", ""));
      const result = await rechargeService.getStatus(orderId);
      sendJson(res, result.status, result.ok ? { success: true, data: result.data } : { success: false, message: result.message });
      return;
    }

    sendJson(res, 404, { success: false, message: "Not found" });
  } catch (error) {
    sendJson(res, 500, {
      success: false,
      message: error instanceof Error ? error.message : "Unknown server error"
    });
  }
});

server.listen(config.port, config.host, () => {
  console.log(`Recharge center MVP listening on http://${config.host}:${config.port}`);
});
