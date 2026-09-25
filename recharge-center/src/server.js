import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import { createAdminAuth } from "./admin-auth.js";

const adminAuth = createAdminAuth({ password: config.adminToken, file: path.join(path.dirname(config.dataFile), "admin-sessions.json"), origin: config.publicBaseUrl });
import { rechargeService } from "./recharge-service.js";
import { proService } from "./pro-orders.js";
import { zzshuService } from "./zzshu-service.js";
import { zzshuAdapter } from "./providers/zzshu-adapter.js";
import { zzshuCredentialStore } from "./zzshu-credential-store.js";
import { hifupayCredentialStore } from "./hifupay-credential-store.js";
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

function serveHCardBatchAdmin(res) {
  const html = fs.readFileSync(path.join(config.rootDir, "admin", "h-card-batch.html"), "utf8");
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer"
  });
  res.end(html);
}

function serveAdminOverview(res) {
  const html = `<!doctype html>
<html lang="zh-CN"><head>
<script src="/admin/session.js"></script><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer">
<title>充值工作台｜GPTC 后台</title>
<style>
*{box-sizing:border-box}body{margin:0;padding:20px;background:#f4f7fb;color:#132033;font-family:system-ui,-apple-system,"Segoe UI",sans-serif}main{max-width:1180px;margin:auto}.panel{background:#fff;border:1px solid #dbe4ee;border-radius:16px;padding:22px;margin-bottom:16px;box-shadow:0 16px 42px #0f172a0d}h1,h2{margin:0 0 8px}h1{font-size:28px}h2{font-size:18px}p,.muted{color:#64748b;line-height:1.55}.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}.api-card{border:1px solid #dbe4ee;border-radius:13px;padding:17px;background:#fbfdff}.status-line{font-weight:800;margin:8px 0 14px}.good{color:#047857}.bad{color:#be123c}.form{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:9px}input{width:100%;min-height:44px;border:1px solid #cbd5e1;border-radius:9px;padding:0 11px;font:inherit}button,.link{min-height:44px;border:1px solid #99f6e4;border-radius:9px;padding:0 14px;background:#ecfdf5;color:#0f766e;font-weight:850;cursor:pointer;text-decoration:none;display:inline-flex;align-items:center;justify-content:center}.actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px}.choices{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:14px}.choices button.active{background:#0f766e;color:#fff;border-color:#0f766e}.message{margin-top:12px;min-height:22px;color:#1e3a8a}.message.error{color:#be123c}.nav{display:flex;gap:9px;flex-wrap:wrap;margin-top:14px}@media(max-width:760px){body{padding:12px}.grid{grid-template-columns:1fr}.form{grid-template-columns:1fr}}
</style></head><body><main>
<section class="panel"><h1>充值工作台</h1><p>从这里进入四项日常管理。客户的登录、获取 JSON、提交卡密和自助充值流程保持现状。</p><div class="nav"><a class="link" href="/admin/cards">卡密管理</a><a class="link" href="/admin/recoveries">充值订单</a><a class="link" href="/admin/hifupay/cards">支付卡池</a><a class="link" href="/admin#protocol-settings">协议设置</a></div><p class="muted">卡密管理可按来源查卡和关联订单；充值订单可查 Plus、Pro 记录及已留存的 JSON；支付卡池保留现有嗨付和 ZZS 卡片管理。</p></section>
<section class="panel"><div class="grid">
<article class="api-card" data-channel="hifupay"><h2>嗨付 API</h2><div class="status-line" id="hifupayState">读取中…</div><div class="form"><input id="hifupayKey" type="password" autocomplete="new-password" placeholder="填写新的嗨付 API Key"><button id="saveHifupay">验证并保存</button></div><div class="actions"><button id="checkHifupay">检测连接</button></div><div class="message" id="hifupayMessage"></div></article>
<article class="api-card" data-channel="zzshu"><h2>ZZS API</h2><div class="status-line" id="zzshuState">读取中…</div><div class="form"><input id="zzshuKey" type="password" autocomplete="new-password" placeholder="填写新的 ZZS API Key"><button id="saveZzshu">验证并保存</button></div><p class="muted">“检测连接”只检查后台已保存的 Key；输入框中的内容需先验证并保存才会生效。旧订单必须使用创建时的原 Key 查询。</p><div class="actions"><button id="checkZzshu">检测连接</button><button id="probeZzshu">诊断上游连通性</button></div><div class="message" id="zzshuMessage"></div></article>
</div></section>
<section class="panel" id="zzshu-query"><h2>ZZS 开通记录</h2><p>使用后台已保存的 ZZS Key 只读查询上游记录，不提交充值，也不修改本站订单。可与<a href="/admin/recoveries">本站充值订单</a>中的账号、时间和上游订单号核对。</p><div class="actions"><button id="queryZzshuUsage">查询上游记录</button><a class="link" href="https://card.zzshu.pro/query" target="_blank" rel="noopener noreferrer">打开 ZZS 查询页</a></div><div class="message" id="zzshuUsageMessage"></div><div id="zzshuUsageResults"></div><div class="actions"><button id="zzshuUsagePrevious" disabled>上一页</button><button id="zzshuUsageNext" disabled>下一页</button></div></section>
<section class="panel" id="protocol-settings"><h2>Plus 通道选择</h2><p>勾选的协议用于尚未首次提交的通用 Plus 卡密。已提交的卡密及订单继续使用原协议；Pro 订单在<a href="/admin/pro-orders">Pro 履约工作台</a>查看。</p><div class="choices"><button data-provider="h">嗨付</button><button data-provider="zzshu">ZZS</button></div><div class="message" id="providerMessage"></div><p class="muted">其他网站入口设置仍在<a href="/admin/provider">路由设置</a>中。</p></section>
<script>
const api=window.adminApi;
function message(id,value,error){const el=document.getElementById(id);el.textContent=value||"";el.classList.toggle("error",Boolean(error))}
async function loadCredential(channel,path){
  try{const d=await api(path);const configured=Boolean(d.configured),button=document.getElementById(channel==="hifupay"?"saveHifupay":"saveZzshu");const state=document.getElementById(channel+"State");state.textContent=configured?"已保存 · 连接待检测 · "+(d.source==="environment"?"部署配置":"后台保存"):"未配置";state.className="status-line "+(configured?"":"bad");document.getElementById(channel+"Key").disabled=!d.canConfigure;button.disabled=!d.canConfigure;button.textContent=configured?"验证并更换":"验证并保存";button.dataset.replace=configured?"1":"0"}catch(e){message(channel+"Message",e.message,true)}
}
async function save(channel,path){
  const input=document.getElementById(channel+"Key"), key=input.value.trim(); if(!key){message(channel+"Message","请填写 API Key。",true);return}
  const button=document.getElementById(channel==="hifupay"?"saveHifupay":"saveZzshu"),replace=button.dataset.replace==="1";if(replace&&!confirm(channel==="zzshu"?"ZZS 旧订单只能用创建时的原 Key 查询。存在未完成订单时系统会拒绝更换。确认继续？":"新 API 验证成功后将替换当前 API。未完成订单存在时系统会拒绝更换。确认继续？"))return;
  try{await api(path,{method:"POST",body:JSON.stringify({apiKey:key,replace})});input.value="";message(channel+"Message",replace?"新 API 验证成功，已完成更换。":"验证成功，已保存。");await loadAll()}catch(e){message(channel+"Message",e.message,true)}
}
async function check(channel,path){const state=document.getElementById(channel+"State");try{const d=await api(path);state.textContent="连接正常 · "+new Date().toLocaleString("zh-CN",{hour12:false});state.className="status-line good";message(channel+"Message","连接正常"+(d.points==null?"":" · 积分 "+d.points))}catch(e){state.textContent="连接检测失败";state.className="status-line bad";message(channel+"Message",e.message,true)}}
async function loadProvider(){try{const d=await api("/api/admin/recharge-dashboard");document.querySelectorAll("[data-provider]").forEach(b=>b.classList.toggle("active",b.dataset.provider===d.plusProvider))}catch(e){message("providerMessage",e.message,true)}}
let zzshuUsagePage=1;
async function loadZzshuUsage(page){
  const button=document.getElementById("queryZzshuUsage");button.disabled=true;message("zzshuUsageMessage","正在查询…");
  try{const d=await api("/api/admin/zzshu/usage?page="+page);zzshuUsagePage=d.page||page;const box=document.getElementById("zzshuUsageResults");box.replaceChildren();
    const summary=document.createElement("p");summary.textContent="上游记录 "+d.total+" 条 · 剩余点数 "+d.remaining+" · 第 "+zzshuUsagePage+" 页";box.append(summary);
    for(const item of d.items||[]){const row=document.createElement("p");row.textContent=[item.createdAt,item.email,item.planType,"开通："+item.status,"续费："+item.cancellation,"扣点："+item.points,"任务："+item.taskNo].join(" · ");box.append(row)}
    if(!d.items?.length){const empty=document.createElement("p");empty.textContent="本页暂无记录";box.append(empty)}
    document.getElementById("zzshuUsagePrevious").disabled=zzshuUsagePage<=1;document.getElementById("zzshuUsageNext").disabled=zzshuUsagePage*20>=d.total;message("zzshuUsageMessage","");
  }catch(e){message("zzshuUsageMessage",e instanceof SyntaxError?"上游或本站网关返回了非 JSON 页面，请稍后重试。":e.message,true)}finally{button.disabled=false}
}
async function loadAll(){await Promise.all([loadCredential("hifupay","/api/admin/hifupay/credential"),loadCredential("zzshu","/api/admin/zzshu/credential"),loadProvider()])}
document.getElementById("queryZzshuUsage").onclick=()=>loadZzshuUsage(1);
document.getElementById("zzshuUsagePrevious").onclick=()=>loadZzshuUsage(zzshuUsagePage-1);
document.getElementById("zzshuUsageNext").onclick=()=>loadZzshuUsage(zzshuUsagePage+1);
document.getElementById("saveHifupay").onclick=()=>save("hifupay","/api/admin/hifupay/credential/verify-and-save");
document.getElementById("saveZzshu").onclick=()=>save("zzshu","/api/admin/zzshu/credential/verify-and-save");
document.getElementById("checkHifupay").onclick=()=>check("hifupay","/api/admin/hifupay/credential/check");
document.getElementById("checkZzshu").onclick=()=>check("zzshu","/api/admin/zzshu/credential/check");
document.getElementById("probeZzshu").onclick=async()=>{try{const d=await api("/api/admin/zzshu/credential/probe");message("zzshuMessage",d.networkReachable?"上游接口可达：测试 Key 按预期被拒绝（HTTP "+d.httpStatus+"，code "+d.code+"）。":d.browserNetworkReachable?"标准请求异常（HTTP "+(d.httpStatus||"?")+"），浏览器请求头可达（HTTP "+d.browserHttpStatus+"）。":"上游接口未正常应答（HTTP "+(d.httpStatus||"?")+"；浏览器请求头 HTTP "+(d.browserHttpStatus||"?")+"），与真实 Key 无关。"+(d.upstreamRay?" CF Ray "+d.upstreamRay:""),!d.networkReachable&&!d.browserNetworkReachable)}catch(e){message("zzshuMessage",e.message,true)}};
document.querySelectorAll("[data-provider]").forEach(b=>b.onclick=async()=>{try{const d=await api("/api/admin/plus-provider",{method:"POST",body:JSON.stringify({provider:b.dataset.provider})});message("providerMessage","新 Plus 卡密已切换到 "+(d.plusProvider==="zzshu"?"ZZS":"嗨付"));await loadProvider()}catch(e){message("providerMessage",e.message,true)}});
loadAll();
</script></main></body></html>`;
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
  res.end(html);
}
function clientIp(req) {
  const realIp = req.headers["x-real-ip"];
  if (typeof realIp === "string" && realIp.trim()) return realIp.trim().slice(0, 80);
  return String(req.socket.remoteAddress || "unknown").slice(0, 80);
}

function createHCardQueryRateLimiter() {
  const minuteLimit = Math.max(Number(config.hCardQueryMinuteLimit) || 10, 1);
  const hourLimit = Math.max(Number(config.hCardQueryHourLimit) || 60, minuteLimit);
  const attempts = new Map();
  return {
    check(req) {
      const now = Date.now();
      const hourAgo = now - 60 * 60 * 1000;
      const minuteAgo = now - 60 * 1000;
      const ip = clientIp(req);
      const recent = (attempts.get(ip) || []).filter(timestamp => timestamp > hourAgo);
      const minuteCount = recent.filter(timestamp => timestamp > minuteAgo).length;
      if (minuteCount >= minuteLimit || recent.length >= hourLimit) {
        attempts.set(ip, recent);
        return { ok: false, retryAfter: minuteCount >= minuteLimit ? 60 : 3600 };
      }
      recent.push(now);
      attempts.set(ip, recent);
      if (attempts.size > 2000) {
        for (const [key, timestamps] of attempts) {
          if (!timestamps.some(timestamp => timestamp > hourAgo)) attempts.delete(key);
        }
      }
      return { ok: true };
    }
  };
}

function adminProviderLabel(provider, publicLabel) {
  return provider === "czgpt" || provider === "czgpt_external" ? "廖" : publicLabel;
}

function adminProviderSettings(settings) {
  return {
    ...settings,
    defaultProviderLabel: adminProviderLabel(settings.defaultProvider, settings.defaultProviderLabel),
    providers: settings.providers.map(provider => ({
      ...provider,
      label: adminProviderLabel(provider.key, provider.label)
    }))
  };
}

function serveProviderAdmin(res) {
  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <script src="/admin/session.js"></script>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>路由与通道 · 网站入口设置｜GPTC 后台</title>
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      color: #132033;
      background: #f4f7fb;
      display: grid;
      place-items: center;
      padding: 20px;
    }
    main {
      width: min(440px, 100%);
      background: #fff;
      border: 1px solid #dbe4ee;
      border-radius: 14px;
      box-shadow: 0 18px 48px rgba(15, 23, 42, 0.08);
      padding: 22px;
    }
    h1 { margin: 0 0 8px; font-size: 24px; }
    p { margin: 0 0 18px; color: #64748b; line-height: 1.6; }
    label { display: grid; gap: 8px; margin-top: 14px; font-weight: 800; }
    label.hidden { display: none; }
    input {
      width: 100%;
      min-height: 46px;
      border: 1px solid #cbd5e1;
      border-radius: 10px;
      padding: 0 12px;
      font: inherit;
    }
    .provider-group { margin-top: 18px; }
    .provider-group + .provider-group { padding-top: 18px; border-top: 1px solid #e2e8f0; }
    .group-title { margin: 0; color: #0f172a; font-size: 16px; font-weight: 950; }
    .group-help { margin: 4px 0 0; color: #64748b; font-size: 13px; line-height: 1.5; }
    .choices { display: grid; grid-template-columns: repeat(auto-fit, minmax(82px, 1fr)); gap: 10px; margin-top: 10px; }
    button {
      min-height: 52px;
      border: 1px solid #cbd5e1;
      border-radius: 12px;
      background: #f8fafc;
      color: #0f172a;
      font: inherit;
      font-weight: 900;
      cursor: pointer;
    }
    button.active { color: #fff; background: #0f766e; border-color: #0f766e; }
    .status {
      margin-top: 16px;
      padding: 12px;
      border-radius: 10px;
      background: #eff6ff;
      border: 1px solid #bfdbfe;
      color: #1e3a8a;
      line-height: 1.6;
    }
    .status.error { background: #fff1f2; border-color: #fda4af; color: #9f1239; }
    .hint {
      margin-top: 12px;
      font-size: 13px;
      color: #64748b;
      line-height: 1.6;
    }
    .channel-entry { margin-top: 22px; padding-top: 18px; border-top: 1px solid #e2e8f0; }
    .channel-links { display: grid; gap: 10px; margin-top: 10px; }
    .channel-link { display: block; padding: 12px; border: 1px solid #dbe4ee; border-radius: 10px; background: #f8fafc; color: #0f172a; text-decoration: none; }
    .channel-link:hover { border-color: #99f6e4; background: #ecfdf5; }
    .channel-link strong { display: block; font-size: 14px; }
    .channel-link span, .channel-static { display: block; margin-top: 4px; color: #64748b; font-size: 13px; line-height: 1.5; }
    .channel-static { padding: 12px; border: 1px dashed #cbd5e1; border-radius: 10px; background: #fff; }
  </style>
</head>
<body>
  <main>
    <h1>其他网站入口</h1>
    <p>这里保留其他充值入口的既有路由。嗨付、ZZS API 和 Plus 通道统一在<a href="/admin">总览</a>管理。</p>

    <div class="provider-group">
      <h2 class="group-title">站内充值</h2>
      <p class="group-help">用户留在 GPTC 页面完成充值。</p>
      <div class="choices">
        <button type="button" data-provider="sange">三哥</button>
        <button type="button" data-provider="ayan">阿妍</button>
        <button type="button" data-provider="j">阿健</button>
        <button type="button" data-provider="czgpt">廖</button>
        <button type="button" data-provider="xiaoyu">小雨</button>
        <button type="button" data-provider="h">h</button>
      </div>
    </div>
    <div class="provider-group">
      <h2 class="group-title">站外充值</h2>
      <p class="group-help">用户进入激活页后，自动跳到所选源头。</p>
      <div class="choices">
        <button type="button" data-provider="sange_external">三哥</button>
        <button type="button" data-provider="ayan_external">阿妍</button>
        <button type="button" data-provider="czgpt_external">廖</button>
        <button type="button" data-provider="dnscon">白</button>
        <button type="button" data-provider="9977ai">七七</button>
      </div>
    </div>
    <div class="status" id="statusBox">正在读取当前通道…</div>
  </main>
  <script>
    const statusBox = document.getElementById("statusBox");
    const buttons = Array.from(document.querySelectorAll("[data-provider]"));

    function setStatus(message, error = false) {
      statusBox.textContent = message;
      statusBox.classList.toggle("error", error);
    }

    function setActive(provider) {
      buttons.forEach((button) => button.classList.toggle("active", button.dataset.provider === provider));
    }

    function providerLocationLabel(data) {
      return data.defaultProviderMode === "redirect" ? "站外充值" : "站内充值";
    }

    const api = window.adminApi;

    async function loadCurrent() {
      try {
        const data = await api("/api/admin/provider");
        setActive(data.defaultProvider);
        setStatus("当前默认方式：" + providerLocationLabel(data) + " · " + data.defaultProviderLabel + (data.providerUpdatedAt ? "\\n最后切换：" + data.providerUpdatedAt : ""));
      } catch (error) {
        setStatus(error.message, true);
      }
    }

    async function switchProvider(provider) {
      try {
        const data = await api("/api/admin/provider", {
          method: "POST",
          body: JSON.stringify({ provider })
        });
        setActive(data.defaultProvider);
        setStatus("已切换为：" + providerLocationLabel(data) + " · " + data.defaultProviderLabel);
      } catch (error) {
        setStatus(error.message, true);
      }
    }

    buttons.forEach((button) => {
      button.addEventListener("click", () => switchProvider(button.dataset.provider));
    });
    loadCurrent();
  </script>
</body>
</html>`;
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(html);
}

function serveHCardAdmin(res) {
  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <script src="/admin/session.js"></script>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="referrer" content="no-referrer">
  <title>产品与卡密 · 生成卡密｜GPTC 后台</title>
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; padding: 20px; font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #132033; background: #f4f7fb; }
    main { width: min(1100px, 100%); margin: 0 auto; }
    section { background: #fff; border: 1px solid #dbe4ee; border-radius: 14px; box-shadow: 0 18px 48px rgba(15, 23, 42, 0.08); padding: 22px; margin-bottom: 16px; }
    h1, h2 { margin: 0 0 8px; }
    h1 { font-size: 26px; }
    h2 { font-size: 18px; }
    p, .hint { color: #64748b; line-height: 1.6; }
    .auth-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 12px; align-items: end; }
    .form { display: grid; grid-template-columns: 1fr 1fr auto; gap: 12px; align-items: end; margin-top: 18px; }
    label { display: grid; gap: 8px; font-weight: 800; }
    input, select { width: 100%; min-height: 44px; border: 1px solid #cbd5e1; border-radius: 10px; padding: 0 12px; font: inherit; background:#fff; }
    button { min-height: 44px; border: 0; border-radius: 10px; padding: 0 18px; color: #fff; background: #0f766e; font: inherit; font-weight: 900; cursor: pointer; }
    button.secondary { color: #0f766e; background: #ecfdf5; border: 1px solid #99f6e4; }
    .status { margin-top: 16px; padding: 12px; border-radius: 10px; background: #eff6ff; border: 1px solid #bfdbfe; color: #1e3a8a; line-height: 1.6; white-space: pre-wrap; }
    .status.error { background: #fff1f2; border-color: #fda4af; color: #9f1239; }
    .generated { display: grid; gap: 10px; margin-top: 14px; max-height: 420px; overflow:auto; }
    .card { padding: 12px; border: 1px solid #dbe4ee; border-radius: 10px; background: #f8fafc; overflow-wrap: anywhere; }
    .card code { display: block; color: #0f172a; font-weight: 900; }
    .card a { display: block; margin-top: 5px; color: #2563eb; font-size: 13px; }
    .row-actions { display: flex; gap: 8px; }
    .row-actions button { min-height: 34px; padding: 0 10px; font-size: 13px; }
    .attention-badge { display: inline-block; margin-top: 5px; padding: 3px 7px; border-radius: 999px; color: #9a3412; background: #ffedd5; font-size: 12px; font-weight: 900; }
    tr.needs-attention { background: #fffaf0; }
    .row-actions button.danger { color: #9f1239; background: #fff1f2; border: 1px solid #fda4af; }
    .action-link { display: inline-flex; align-items: center; min-height: 44px; padding: 0 18px; border-radius: 10px; color: #0f766e; background: #ecfdf5; border: 1px solid #99f6e4; font-weight: 900; text-decoration: none; }
    .page-actions { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 14px; }
    .output-actions { display:none; gap:10px; flex-wrap:wrap; margin-top:14px; padding-top:14px; border-top:1px solid #e2e8f0; }
    .generated .card { display:grid; gap:5px; }
    .generated .card-head { display:flex; justify-content:space-between; gap:10px; color:#64748b; font-size:13px; }
    .state { color:#047857; font-weight:900; }
    .card-code { display: inline-block; min-width: 220px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-weight: 900; }
    .copy-card { min-height: 32px !important; padding: 0 9px !important; margin-left: 8px; font-size: 12px !important; }
    .table-wrap { overflow-x: auto; }
    table { width: 100%; border-collapse: collapse; margin-top: 12px; font-size: 14px; }
    th, td { padding: 10px 8px; text-align: left; border-bottom: 1px solid #e2e8f0; white-space: nowrap; }
    th { color: #475569; }
    .hint { margin: 10px 0 0; font-size: 13px; }
    @media (max-width: 640px) { .auth-row, .form { grid-template-columns: 1fr; } button { width: 100%; } section { padding: 16px; } }
  </style>
</head>
<body>
  <main>
    <section>
      <h1>产品与卡密 · 生成卡密</h1>
      <p>Plus 卡密生成时不绑定协议。未提交的卡密跟随首页的 Plus 通道设置；首次提交后固定使用该通道。Pro 卡密按原流程处理。<a href="/admin#protocol-settings">设置 Plus 通道</a></p>

      <div class="form">
        <label>卡密套餐<select id="plan"><option value="plus">Plus</option><option value="pro_x5">Pro 5x</option><option value="pro_x20">Pro 20x</option></select></label>
        <label>生成数量<input id="count" type="number" min="1" max="100" value="10"></label>
        <label>销售渠道<select id="source"><option>卡网</option><option>微信</option><option>代理</option><option>漫飞公司</option><option value="custom">其他</option></select><input id="customSource" type="text" maxlength="40" placeholder="例如：代理张三、某公司团购" hidden></label>
        <button id="generate" type="button">生成卡密</button>
      </div>
      <div class="status" id="statusBox">卡网：批量复制链接上传，再按相同顺序复制卡密入表。微信：下载每张卡一个 TXT 的链接 ZIP，再按相同顺序复制卡密入表。TXT 只含充值链接。</div>
      <div class="page-actions"><a class="action-link" href="/admin/cards/library">卡密库</a><a class="action-link" href="/admin/cards/batch">批量查询</a></div>
      <div class="output-actions" id="outputActions"><button class="secondary" id="copyCodes">复制全部纯卡密（入表）</button><button class="secondary" id="copyLinks">复制全部充值链接（卡网）</button><button class="secondary" id="downloadLinkZip">下载每张一个 TXT（微信）</button><a class="action-link" id="openGeneratedBatch" href="/admin/cards/library" style="display:none">在卡密库找回本批</a></div>
      <div class="generated" id="generated"></div>
    </section>
  </main>
  <script>
    const statusBox = document.getElementById("statusBox");
    const generated = document.getElementById("generated");
    let generatedCards = [];

    function setStatus(message, error = false) {
      statusBox.textContent = message;
      statusBox.classList.toggle("error", error);
    }

    function escapeHtml(value) {
      return String(value ?? "").replace(/[&<>\"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '\"': "&quot;", "'": "&#39;" }[character]));
    }

    function formatDate(value) {
      if (!value) return "永久";
      const date = new Date(value);
      return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString("zh-CN", { hour12: false });
    }

    async function copyCardCode(button) {
      const code = button.dataset.cardCode || "";
      if (!code) return;
      try {
        await navigator.clipboard.writeText(code);
        button.textContent = "已复制";
        window.setTimeout(() => { button.textContent = "复制"; }, 1200);
      } catch { setStatus("复制失败，请手动选择卡密复制。", true); }
    }

    const api = window.adminApi;

    function currentSource() {
      const selected = document.getElementById("source").value;
      return selected === "custom" ? document.getElementById("customSource").value.trim() : selected;
    }
    function outputText(type) {
      return generatedCards.map(card => type === "links" ? card.link : card.code).join("\\n");
    }
    function downloadBlob(blob, name) {
      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      link.download = name;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    }
    function concatBytes(parts) {
      const output = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
      let offset = 0;
      parts.forEach(part => { output.set(part, offset); offset += part.length; });
      return output;
    }
    function crc32(bytes) {
      let crc = 0xffffffff;
      for (const byte of bytes) {
        crc ^= byte;
        for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
      }
      return (crc ^ 0xffffffff) >>> 0;
    }
    function zipLinks() {
      if (!generatedCards.length) return;
      const encoder = new TextEncoder();
      const u16 = value => new Uint8Array([value & 255, (value >>> 8) & 255]);
      const u32 = value => new Uint8Array([value & 255, (value >>> 8) & 255, (value >>> 16) & 255, (value >>> 24) & 255]);
      const localParts = [], centralParts = [];
      let offset = 0;
      const stamp = new Date().toLocaleDateString("sv-SE").replaceAll("-", "");
      const source = (currentSource() || "未分类").replace(/[\\/:*?"<>|]/g, "-");
      generatedCards.forEach((card, index) => {
        const name = encoder.encode(stamp + "-" + source + "-" + String(card.sequence || index + 1).padStart(3, "0") + "-" + String(card.code || "").slice(-4) + ".txt");
        const data = encoder.encode(String(card.link || "") + "\\n");
        const checksum = crc32(data);
        const local = concatBytes([new Uint8Array([80,75,3,4,20,0,0,0,0,0,0,0,0,0]), u32(checksum), u32(data.length), u32(data.length), u16(name.length), u16(0), name, data]);
        const central = concatBytes([new Uint8Array([80,75,1,2,20,0,20,0,0,0,0,0,0,0,0,0]), u32(checksum), u32(data.length), u32(data.length), u16(name.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset), name]);
        localParts.push(local); centralParts.push(central); offset += local.length;
      });
      const central = concatBytes(centralParts);
      const end = concatBytes([new Uint8Array([80,75,5,6,0,0,0,0]), u16(generatedCards.length), u16(generatedCards.length), u32(central.length), u32(offset), u16(0)]);
      downloadBlob(new Blob([concatBytes([...localParts, central, end])], { type: "application/zip" }), stamp + "-" + source + "-链接.zip");
      setStatus("已下载链接 ZIP，每张卡密一个 TXT 文件。");
    }
    async function copyOutput(type) {
      if (!generatedCards.length) return;
      await navigator.clipboard.writeText(outputText(type));
      setStatus(type === "links" ? "全部充值链接已复制。" : "全部卡密已复制，可直接粘贴到 Excel。");
    }
    function syncCustomSource() {
      const source = document.getElementById("source");
      const customSource = document.getElementById("customSource");
      const isCustom = source.value === "custom";
      customSource.hidden = !isCustom;
      customSource.required = isCustom;
    }
    document.getElementById("source").addEventListener("change", syncCustomSource);
    window.addEventListener("pageshow", syncCustomSource);
    syncCustomSource();
    document.getElementById("copyCodes").onclick = () => copyOutput("codes");
    document.getElementById("copyLinks").onclick = () => copyOutput("links");
    document.getElementById("downloadLinkZip").onclick = zipLinks;

    document.getElementById("generate").addEventListener("click", async () => {
      try {
        const source = currentSource();
        if (!source) throw new Error("请输入销售来源。");
        const plan = document.getElementById("plan").value;
        const data = await api("/api/admin/h-cards", { method: "POST", body: JSON.stringify({ count: Number(document.getElementById("count").value), source, plan, productId: 3 }) });
        generatedCards = data.cards;
        generated.innerHTML = data.cards.map((card, index) => '<div class="card"><div class="card-head"><span>第 ' + (card.sequence || index + 1) + ' 张 · ' + escapeHtml(card.source || source) + ' · ' + escapeHtml(plan) + '</span><span class="state">未使用</span></div><code>' + escapeHtml(card.code) + '</code><a href="' + escapeHtml(card.link) + '" target="_blank" rel="noreferrer">' + escapeHtml(card.link) + '</a></div>').join("");
        document.getElementById("outputActions").style.display = "flex";
        const batchId = data.cards[0]?.batchId || "";
        const batchLink = document.getElementById("openGeneratedBatch");
        batchLink.href = "/admin/cards/library" + (batchId ? "?batch=" + encodeURIComponent(batchId) : "");
        batchLink.style.display = batchId ? "inline-flex" : "none";
        setStatus("已生成 " + data.cards.length + " 张卡密。纯卡密、充值链接和 TXT 按相同顺序排列；关闭页面后可从卡密库按批次重新导出。");
      } catch (error) { setStatus(error.message, true); }
    });
  </script>
</body>
</html>`;
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer"
  });
  res.end(html);
}

function serveHCardLibraryAdmin(res) {
  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <script src="/admin/session.js"></script>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="referrer" content="no-referrer">
  <title>产品与卡密 · 卡密库｜GPTC 后台</title>
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; padding: 20px; font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #132033; background: #f4f7fb; }
    main { width: min(1180px, 100%); margin: 0 auto; }
    section { background: #fff; border: 1px solid #dbe4ee; border-radius: 14px; box-shadow: 0 18px 48px rgba(15, 23, 42, 0.08); padding: 22px; margin-bottom: 16px; }
    h1 { margin: 0 0 8px; font-size: 26px; }
    p, .hint { color: #64748b; line-height: 1.6; }
    .topbar { display: flex; align-items: center; justify-content: space-between; gap: 14px; flex-wrap: wrap; }
    .top-actions { display: flex; gap: 10px; flex-wrap: wrap; }
    .back-link, button { min-height: 44px; border-radius: 10px; padding: 0 16px; font: inherit; font-weight: 900; cursor: pointer; }
    .back-link { display: inline-flex; align-items: center; color: #0f766e; background: #ecfdf5; border: 1px solid #99f6e4; text-decoration: none; }
    button { border: 0; color: #fff; background: #0f766e; }
    button.secondary { color: #0f766e; background: #ecfdf5; border: 1px solid #99f6e4; }
    button.danger { color: #9f1239; background: #fff1f2; border: 1px solid #fda4af; }
    button:disabled { opacity: .55; cursor: wait; }
    label { display: grid; gap: 8px; max-width: 620px; font-weight: 800; }
    input, select { width: 100%; min-height: 44px; border: 1px solid #cbd5e1; border-radius: 10px; padding: 0 12px; font: inherit; background:#fff; }
    .toolbar { display: flex; align-items: end; justify-content: space-between; gap: 12px; flex-wrap: wrap; margin-top: 18px; }
    .bulk-actions { display:flex; gap:8px; flex-wrap:wrap; margin-top:12px; padding:12px; background:#f8fafc; border-radius:10px; }
    .batch-actions { display:none; gap:8px; align-items:center; flex-wrap:wrap; margin-top:12px; padding:12px; border:1px solid #99f6e4; border-radius:10px; background:#ecfdf5; }
    .check { width:18px; min-height:18px; }
    .status { margin-top: 16px; padding: 12px; border-radius: 10px; background: #eff6ff; border: 1px solid #bfdbfe; color: #1e3a8a; line-height: 1.6; white-space: pre-wrap; }
    .status.error { background: #fff1f2; border-color: #fda4af; color: #9f1239; }
    .count { color: #475569; font-weight: 800; }
    .table-wrap { overflow-x: auto; margin-top: 14px; }
    table { width: 100%; border-collapse: collapse; font-size: 14px; }
    th, td { padding: 11px 8px; text-align: left; border-bottom: 1px solid #e2e8f0; white-space: nowrap; }
    th { color: #475569; }
    .row-actions { display: flex; gap: 8px; }
    .row-actions button { min-height: 34px; padding: 0 10px; font-size: 13px; }
    .card-code { display: inline-block; min-width: 220px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-weight: 900; }
    .copy-card { min-height: 32px !important; padding: 0 9px !important; margin-left: 8px; font-size: 12px !important; }
    .hint { margin: 10px 0 0; font-size: 13px; }
    @media (max-width: 640px) { body { padding: 12px; } section { padding: 16px; } .toolbar { align-items: stretch; } .toolbar button, .top-actions > * { width: 100%; justify-content: center; } }
  </style>
</head>
<body>
  <main>
    <section>
      <div class="topbar">
        <div><h1>产品与卡密 · 卡密库</h1><p class="hint">管理客户兑换卡密；按来源、状态和生成日期筛选，支持批量管理。提交过资料的卡密只能归档，不能删除。</p></div>
        <div class="top-actions"><a class="back-link" href="/admin/cards">生成卡密</a><a class="back-link" href="/admin/cards/batch">批量查询</a><button class="secondary" id="refresh" type="button">刷新列表</button></div>
      </div>

      <div class="status" id="statusBox">正在加载卡密…</div>
    </section>
    <section>
      <div class="toolbar"><label>生成批次<select id="batchFilter"><option value="">全部批次</option></select></label><label>搜索<input id="cardSearch" type="search" placeholder="卡密片段、后四位、邮箱或充值链接"></label><label>套餐<select id="planFilter"><option value="">全部套餐</option><option value="plus">Plus</option><option value="pro_x5">Pro 5x</option><option value="pro_x20">Pro 20x</option></select></label><label>来源<select id="sourceFilter"><option value="">全部来源</option></select></label><label>状态<select id="cardStatusFilter"><option value="">全部状态</option><option value="unused">未使用</option><option value="locked">已锁定</option><option value="used">已使用</option><option value="disabled">已禁用</option><option value="archived">已归档</option></select></label><label>生成日期<input id="dateFilter" type="date"></label><label style="display:flex;grid-auto-flow:column;align-items:center;justify-content:start"><input id="showArchived" type="checkbox" class="check">显示归档</label><span class="count" id="libraryCount">-</span></div>
      <div class="batch-actions" id="batchActions"><strong id="batchSummary"></strong><span class="hint">包含已使用及归档卡；导出整批，不受搜索和状态筛选影响。请勿重新发放已使用卡。</span><button class="secondary" id="copyBatchCodes">复制本批纯卡密</button><button class="secondary" id="copyBatchLinks">复制本批充值链接</button><button class="secondary" id="downloadBatchLinks">下载本批 TXT ZIP</button></div>
      <div class="bulk-actions"><button class="secondary" id="selectAll">全选当前结果</button><button class="secondary" id="invertSelection">反选</button><button class="secondary" id="copySelectedCodes">复制选中卡密</button><button class="secondary" id="copySelectedLinks">复制选中链接</button><button class="secondary" id="downloadSelectedZip">下载选中 ZIP</button><button class="secondary" id="downloadSelectedLinkZip">下载链接 ZIP</button><button data-bulk-action="disable">批量禁用</button><button class="secondary" data-bulk-action="enable">批量启用</button><button class="secondary" data-bulk-action="archive">批量归档</button><button class="danger" data-bulk-action="delete">批量删除</button><strong id="selectedCount">已选 0 张</strong></div>
      <div class="table-wrap">
        <table>
          <thead><tr><th><input id="selectPage" type="checkbox" class="check" title="全选当前结果"></th><th>序号</th><th>卡密</th><th>套餐</th><th>来源</th><th>状态</th><th>绑定账号</th><th>生成时间</th><th>操作</th></tr></thead>
          <tbody id="libraryCards"></tbody>
        </table>
      </div>
    </section>
  </main>
  <script>
    const statusBox = document.getElementById("statusBox");

    function setStatus(message, error = false) {
      statusBox.textContent = message;
      statusBox.classList.toggle("error", error);
    }

    function escapeHtml(value) {
      return String(value ?? "").replace(/[&<>\"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '\"': "&quot;", "'": "&#39;" }[character]));
    }

    function formatDate(value) {
      if (!value) return "永久";
      const date = new Date(value);
      return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString("zh-CN", { hour12: false });
    }

    async function copyCardCode(button) {
      const code = button.dataset.cardCode || "";
      if (!code) return;
      try {
        await navigator.clipboard.writeText(code);
        button.textContent = "已复制";
        window.setTimeout(() => { button.textContent = "复制"; }, 1200);
      } catch { setStatus("复制失败，请手动选择卡密复制。", true); }
    }

    const api = window.adminApi;

    const statusLabels = { unused: "未使用", locked: "已锁定", reserved: "处理中", used: "已使用", disabled: "已禁用", expired: "已过期", archived: "已归档" };
    let allCards = [];
    let filteredCards = [];
    let ordersByCardId = new Map();
    let initialBatchId = new URLSearchParams(window.location.search || "").get("batch") || "";
    const selectedCards = new Set();

    function batchCards() {
      const id = document.getElementById("batchFilter").value;
      if (!id) return [];
      return allCards.filter(card => card.batchId === id).sort((a, b) => {
        const first = Number(a.sequence) || allCards.length - allCards.indexOf(a);
        const second = Number(b.sequence) || allCards.length - allCards.indexOf(b);
        return first - second;
      });
    }
    function updateBatchSummary() {
      const rows = batchCards();
      const panel = document.getElementById("batchActions");
      panel.style.display = rows.length ? "flex" : "none";
      if (!rows.length) return;
      const unused = rows.filter(card => !card.archivedAt && card.status === "unused" && !card.hasSubmission).length;
      const original = Number(rows[0].batchSize) || rows.length;
      document.getElementById("batchSummary").textContent = (rows[0].source || "未分类") + " · " + formatDate(rows[0].createdAt) + " · 本批原有 " + original + " 张，现存 " + rows.length + " 张，未使用 " + unused + " 张" + (original > rows.length ? "；有 " + (original - rows.length) + " 张已删除，无法完整重导" : "");
    }

    function ordersForCard(card) { return ordersByCardId.get(card.id) || []; }
    function preferredOrder(card) {
      const orders = ordersForCard(card);
      return orders.find(order => order.status === "success") || orders[0] || null;
    }
    function searchKeyword(value) {
      const text = String(value || "").trim();
      try {
        const url = new URL(text);
        return (url.searchParams.get("card") || url.searchParams.get("code") || text).trim().toLowerCase();
      } catch { return text.toLowerCase(); }
    }

    async function copyOrderJson(orderId) {
      try {
        const detail = await api("/api/admin/recoveries/" + encodeURIComponent(orderId) + "?reveal=1");
        if (!detail.secretJsonText) return setStatus("这笔订单没有留存可复制的 JSON。", true);
        await navigator.clipboard.writeText(detail.secretJsonText);
        setStatus("已复制所选订单的 JSON。");
      } catch (error) { setStatus(error.message || "复制 JSON 失败。", true); }
    }

    function renderRows(cards) {
      return cards.map((card, index) => {
        const effectiveStatus = card.archivedAt ? "archived" : card.status;
        const linkedOrders = ordersForCard(card);
        const selectedOrder = preferredOrder(card);
        const orderActionHtml = linkedOrders.length
          ? '<a class="back-link" href="/admin/recoveries?cardId=' + encodeURIComponent(card.id) + '">查看订单（' + linkedOrders.length + '）</a>'
            + (selectedOrder?.hasOriginalJson
              ? '<button class="secondary" type="button" data-card-action="copy-json" data-order-id="' + escapeHtml(selectedOrder.id) + '">复制JSON</button>'
              : '<span class="hint">未留存 JSON</span>')
          : "";
        const actionHtml = [
          orderActionHtml,
          card.code ? '<button class="secondary" type="button" data-card-action="copy-link" data-card-code="' + escapeHtml(card.code) + '">复制充值链接</button>' : "",
          card.archivedAt ? '<button type="button" data-card-action="restore" data-card-id="' + escapeHtml(card.id) + '">恢复</button>' : "",
          !card.archivedAt && card.hasSubmission ? '<button class="secondary" type="button" data-card-action="archive" data-card-id="' + escapeHtml(card.id) + '">归档</button>' : "",
          !card.archivedAt && !card.hasSubmission && ["unused", "expired", "disabled"].includes(card.status) ? '<button class="danger" type="button" data-card-action="delete" data-card-id="' + escapeHtml(card.id) + '">删除</button>' : "",
          !card.archivedAt && (card.status === "locked" || card.status === "reserved")
            ? '<button type="button" data-card-action="unlock" data-card-id="' + escapeHtml(card.id) + '">解锁</button>'
            : "",
          !card.archivedAt && card.status === "disabled"
            ? '<button type="button" data-card-action="enable" data-card-id="' + escapeHtml(card.id) + '">启用</button>'
            : !card.archivedAt ? '<button class="danger" type="button" data-card-action="disable" data-card-id="' + escapeHtml(card.id) + '">禁用</button>' : ""
        ].filter(Boolean).join("");
        const account = [card.boundEmail || selectedOrder?.userEmail, card.boundAccountId].filter(Boolean).join(" / ") || "-";
        const orderSummary = selectedOrder
          ? '<br><small>通道 ' + escapeHtml(selectedOrder.provider) + ' · ' + escapeHtml(selectedOrder.status === "success" ? "充值成功" : selectedOrder.status === "failed" ? "失败" : "处理中") + ' · ' + escapeHtml(formatDate(selectedOrder.createdAt)) + '</small>'
          : "";
        const code = card.code || card.cardMask || "-";
        return '<tr><td><input class="check row-check" type="checkbox" data-card-id="' + escapeHtml(card.id) + '"' + (selectedCards.has(card.id) ? ' checked' : '') + '></td><td>' + (index + 1) + '</td><td><span class="card-code">' + escapeHtml(code) + '</span>' + (card.code ? '<button class="secondary copy-card" type="button" data-card-code="' + escapeHtml(card.code) + '" onclick="copyCardCode(this)">复制</button>' : '') + '</td><td>' + escapeHtml(card.plan === "pro_x5" ? "Pro 5x" : card.plan === "pro_x20" ? "Pro 20x" : "Plus") + '</td><td>' + escapeHtml(card.source || "未分类") + '</td><td>' + escapeHtml(statusLabels[effectiveStatus] || effectiveStatus) + '</td><td>' + escapeHtml(account) + orderSummary + '</td><td>' + escapeHtml(formatDate(card.createdAt)) + '</td><td><div class="row-actions">' + actionHtml + '</div></td></tr>';
      }).join("") || '<tr><td colspan="9">暂无匹配卡密</td></tr>';
    }

    function applyFilter() {
      const batchId = document.getElementById("batchFilter").value;
      const keyword = searchKeyword(document.getElementById("cardSearch").value);
      const source = document.getElementById("sourceFilter").value;
      const status = document.getElementById("cardStatusFilter").value;
      const plan = document.getElementById("planFilter").value;
      const date = document.getElementById("dateFilter").value;
      filteredCards = allCards.filter(card => {
        const effectiveStatus = card.archivedAt ? "archived" : card.status;
        const matchesKeyword = !keyword || [card.code, card.cardMask, card.boundEmail, card.boundAccountId,
          ...ordersForCard(card).flatMap(order => [order.userEmail, order.id])]
          .some(value => String(value || "").toLowerCase().includes(keyword));
        return (!batchId || card.batchId === batchId) && (batchId || document.getElementById("showArchived").checked || !card.archivedAt)
          && matchesKeyword && (!plan || (card.plan || "plus") === plan) && (!source || card.source === source) && (!status || effectiveStatus === status) && (!date || String(card.createdAt || "").slice(0, 10) === date);
      });
      if (batchId) filteredCards.sort((a, b) => (Number(a.sequence) || allCards.length - allCards.indexOf(a)) - (Number(b.sequence) || allCards.length - allCards.indexOf(b)));
      document.getElementById("libraryCards").innerHTML = renderRows(filteredCards);
      const visibleTotal = batchId ? batchCards().length : allCards.filter(card => document.getElementById("showArchived").checked || !card.archivedAt).length;
      document.getElementById("libraryCount").textContent = filteredCards.length + " / " + visibleTotal + " 张";
      updateBatchSummary();
      const visibleSelected = filteredCards.filter(card => selectedCards.has(card.id)).length;
      document.getElementById("selectedCount").textContent = "已选 " + visibleSelected + " 张";
      document.getElementById("selectPage").checked = filteredCards.length > 0 && filteredCards.every(card => selectedCards.has(card.id));
    }

    async function loadLibrary() {
      try {
        const data = await api("/api/admin/h-cards?all=1&reveal=1&archived=1");
        let history = { records: [] };
        let historyUnavailable = false;
        try { history = await api("/api/admin/recharge-records"); }
        catch { historyUnavailable = true; }
        selectedCards.clear();
        allCards = data.cards;
        ordersByCardId = new Map();
        for (const order of history.records || []) {
          if (!order.customerCardId) continue;
          const list = ordersByCardId.get(order.customerCardId) || [];
          list.push(order);
          ordersByCardId.set(order.customerCardId, list);
        }
        for (const list of ordersByCardId.values())
          list.sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
        const sourceFilter = document.getElementById("sourceFilter");
        const selectedSource = sourceFilter.value;
        const sources = [...new Set(allCards.map(card => card.source || "未分类"))].sort();
        sourceFilter.innerHTML = '<option value="">全部来源</option>' + sources.map(source => '<option value="' + escapeHtml(source) + '">' + escapeHtml(source) + '</option>').join("");
        sourceFilter.value = selectedSource;
        const batchFilter = document.getElementById("batchFilter");
        const selectedBatch = batchFilter.value || initialBatchId;
        const batches = new Map();
        for (const card of allCards) if (card.batchId) {
          const batch = batches.get(card.batchId) || { source: card.source || "未分类", createdAt: card.createdAt, count: 0 };
          batch.count += 1;
          batches.set(card.batchId, batch);
        }
        batchFilter.innerHTML = '<option value="">全部批次</option>' + [...batches.entries()].map(([id, batch]) => '<option value="' + escapeHtml(id) + '">' + escapeHtml((batch.source || "未分类") + " · " + formatDate(batch.createdAt) + " · " + batch.count + " 张") + '</option>').join("");
        batchFilter.value = batches.has(selectedBatch) ? selectedBatch : "";
        initialBatchId = "";
        applyFilter();
        setStatus(historyUnavailable ? "已加载卡密，订单记录暂不可用，请稍后刷新。" : "已加载全部卡密。", historyUnavailable);
      } catch (error) { setStatus(error.message, true); }
    }

    document.getElementById("refresh").addEventListener("click", loadLibrary);
    function clearSelectionAndFilter() {
      selectedCards.clear();
      applyFilter();
    }
    document.getElementById("cardSearch").addEventListener("input", clearSelectionAndFilter);
    document.getElementById("batchFilter").addEventListener("change", () => {
      selectedCards.clear();
      for (const id of ["cardSearch", "planFilter", "sourceFilter", "cardStatusFilter", "dateFilter"]) document.getElementById(id).value = "";
      applyFilter();
    });
    document.getElementById("sourceFilter").addEventListener("change", clearSelectionAndFilter);
    document.getElementById("cardStatusFilter").addEventListener("change", clearSelectionAndFilter);
    document.getElementById("planFilter").addEventListener("change", clearSelectionAndFilter);
    document.getElementById("dateFilter").addEventListener("change", clearSelectionAndFilter);
    document.getElementById("showArchived").addEventListener("change", clearSelectionAndFilter);
    document.getElementById("libraryCards").addEventListener("change", event => {
      const checkbox = event.target.closest(".row-check");
      if (!checkbox) return;
      checkbox.checked ? selectedCards.add(checkbox.dataset.cardId) : selectedCards.delete(checkbox.dataset.cardId);
      applyFilter();
    });
    function selectFiltered(mode) {
      filteredCards.forEach(card => mode === "all" ? selectedCards.add(card.id) : selectedCards.has(card.id) ? selectedCards.delete(card.id) : selectedCards.add(card.id));
      applyFilter();
    }
    function selectedCardRows() {
      return filteredCards.filter(card => selectedCards.has(card.id) && card.code);
    }
    function cardLink(card) {
      return window.location.origin + "/activate/?provider=h&card=" + encodeURIComponent(card.code);
    }
    function downloadBlob(blob, name) {
      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      link.download = name;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    }
    function concatBytes(parts) {
      const total = parts.reduce((sum, part) => sum + part.length, 0);
      const output = new Uint8Array(total);
      let offset = 0;
      parts.forEach(part => { output.set(part, offset); offset += part.length; });
      return output;
    }
    function crc32(bytes) {
      let crc = 0xffffffff;
      for (const byte of bytes) {
        crc ^= byte;
        for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
      }
      return (crc ^ 0xffffffff) >>> 0;
    }
    function zipFiles(files) {
      const encoder = new TextEncoder();
      const localParts = [];
      const centralParts = [];
      let offset = 0;
      const u16 = value => new Uint8Array([value & 255, (value >>> 8) & 255]);
      const u32 = value => new Uint8Array([value & 255, (value >>> 8) & 255, (value >>> 16) & 255, (value >>> 24) & 255]);
      files.forEach(file => {
        const name = encoder.encode(file.name);
        const data = encoder.encode(file.text);
        const checksum = crc32(data);
        const local = concatBytes([new Uint8Array([80, 75, 3, 4, 20, 0, 0, 0, 0, 0, 0, 0, 0, 0]), u32(checksum), u32(data.length), u32(data.length), u16(name.length), u16(0), name, data]);
        const central = concatBytes([new Uint8Array([80, 75, 1, 2, 20, 0, 20, 0, 0, 0, 0, 0, 0, 0, 0, 0]), u32(checksum), u32(data.length), u32(data.length), u16(name.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset), name]);
        localParts.push(local);
        centralParts.push(central);
        offset += local.length;
      });
      const central = concatBytes(centralParts);
      const end = concatBytes([new Uint8Array([80, 75, 5, 6, 0, 0, 0, 0]), u16(files.length), u16(files.length), u32(central.length), u32(offset), u16(0)]);
      return new Blob([concatBytes([...localParts, central, end])], { type: "application/zip" });
    }
    function completeBatch() {
      const rows = batchCards();
      if (!rows.length) { setStatus("请先选择生成批次。", true); return []; }
      if (Number(rows[0].batchSize) > rows.length) { setStatus("本批有卡密已永久删除，无法完整重导。", true); return []; }
      if (rows.some(card => !card.code)) { setStatus("本批有卡密已被删除或无法读取，不能完整导出。", true); return []; }
      return rows;
    }
    async function copyBatch(type) {
      const rows = completeBatch();
      if (!rows.length) return;
      try {
        await navigator.clipboard.writeText(rows.map(card => type === "links" ? cardLink(card) : card.code).join("\\n"));
        setStatus("已按原始顺序复制本批 " + rows.length + " 张" + (type === "links" ? "充值链接。" : "纯卡密。"));
      } catch { setStatus("复制本批内容失败。", true); }
    }
    function downloadBatchLinks() {
      const rows = completeBatch();
      if (!rows.length) return;
      const files = rows.map((card, index) => ({
        name: String(card.sequence || index + 1).padStart(3, "0") + "-" + card.code.slice(-4) + ".txt",
        text: cardLink(card) + "\\n"
      }));
      downloadBlob(zipFiles(files), "链接批次-" + rows[0].batchId + ".zip");
      setStatus("已下载本批 " + rows.length + " 个 TXT，每个文件只含一条充值链接。请核对已使用卡状态后再发放。");
    }
    document.getElementById("copyBatchCodes").onclick = () => copyBatch("codes");
    document.getElementById("copyBatchLinks").onclick = () => copyBatch("links");
    document.getElementById("downloadBatchLinks").onclick = downloadBatchLinks;
    async function copySelected(type) {
      const rows = selectedCardRows();
      if (!rows.length) return setStatus("请先勾选有完整卡密的记录。", true);
      await navigator.clipboard.writeText(rows.map(card => type === "links" ? cardLink(card) : card.code).join("\\n"));
      setStatus("已复制选中 " + rows.length + " 张" + (type === "links" ? "充值链接。" : "卡密。"));
    }
    function downloadSelectedZip() {
      const rows = selectedCardRows();
      if (!rows.length) return setStatus("请先勾选有完整卡密的记录。", true);
      const files = rows.map((card, index) => {
        const number = String(index + 1).padStart(3, "0");
        const tail = String(card.code).slice(-4);
        return { name: number + "-" + tail + ".txt", text: card.code + "\\n" };
      });
      downloadBlob(zipFiles(files), "选中卡密-" + rows.length + "张.zip");
    }
    function downloadSelectedLinkZip() {
      const rows = selectedCardRows();
      if (!rows.length) return setStatus("请先勾选有完整卡密的记录。", true);
      const files = rows.map((card, index) => {
        const number = String(index + 1).padStart(3, "0");
        const tail = String(card.code).slice(-4);
        return { name: number + "-" + tail + ".txt", text: cardLink(card) + "\\n" };
      });
      downloadBlob(zipFiles(files), "选中链接-" + rows.length + "张.zip");
    }
    document.getElementById("selectAll").onclick = () => selectFiltered("all");
    document.getElementById("invertSelection").onclick = () => selectFiltered("invert");
    document.getElementById("copySelectedCodes").onclick = () => copySelected("codes");
    document.getElementById("copySelectedLinks").onclick = () => copySelected("links");
    document.getElementById("downloadSelectedZip").onclick = downloadSelectedZip;
    document.getElementById("downloadSelectedLinkZip").onclick = downloadSelectedLinkZip;
    document.getElementById("selectPage").onchange = event => {
      filteredCards.forEach(card => event.target.checked ? selectedCards.add(card.id) : selectedCards.delete(card.id));
      applyFilter();
    };
    document.querySelectorAll("[data-bulk-action]").forEach(button => button.onclick = async () => {
      const action = button.dataset.bulkAction;
      const ids = filteredCards.filter(card => selectedCards.has(card.id)).map(card => card.id);
      if (!ids.length) return setStatus("请先勾选卡密。", true);
      if (!confirm("确认对已选 " + ids.length + " 张卡密执行“" + button.textContent.trim() + "”？")) return;
      try {
        const data = await api("/api/admin/h-cards/bulk", { method:"POST", body:JSON.stringify({ cardIds:ids, action }) });
        selectedCards.clear();
        await loadLibrary();
        setStatus("批量操作完成：成功 " + data.successCount + " 张，未处理 " + data.failedCount + " 张。");
      } catch (error) { setStatus(error.message, true); }
    });
    document.getElementById("libraryCards").addEventListener("click", async event => {
      const button = event.target.closest("[data-card-action]");
      if (!button) return;
      if (button.dataset.cardAction === "copy-json") return copyOrderJson(button.dataset.orderId);
      if (button.dataset.cardAction === "copy-link") {
        try {
          await navigator.clipboard.writeText(cardLink({ code: button.dataset.cardCode }));
          setStatus("充值链接已复制。");
        } catch { setStatus("复制充值链接失败。", true); }
        return;
      }
      button.disabled = true;
      try {
        const action = button.dataset.cardAction;
        if (action === "delete" && !confirm("确认永久删除这张未提交过资料的卡密？删除后无法恢复。")) { button.disabled = false; return; }
        if (action === "archive" && !confirm("确认归档这张卡密？充值记录会继续保留。")) { button.disabled = false; return; }
        await api("/api/admin/h-cards/" + encodeURIComponent(button.dataset.cardId) + "/" + action, { method: "POST", body: "{}" });
        await loadLibrary();
        setStatus(action === "unlock" ? "卡密已解锁，原账号绑定仍保留。" : action === "disable" ? "卡密已禁用。" : action === "enable" ? "卡密已启用。" : action === "delete" ? "卡密已永久删除。" : action === "archive" ? "卡密已归档。" : "卡密已恢复。");
      } catch (error) {
        setStatus(error.message, true);
        button.disabled = false;
      }
    });
    loadLibrary();
  </script>
</body>
</html>`;
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer"
  });
  res.end(html);
}

function serveHifupayCardAdmin(res) { serveAdminAsset(res, "payment-cards.html"); }

function serveRecoveryAdmin(res) {
  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <script src="/admin/session.js"></script>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="referrer" content="no-referrer">
  <title>充值订单 · 历史记录｜GPTC 后台</title>
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; padding: 20px; font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #132033; background: #f4f7fb; }
    main { width: min(1180px, 100%); margin: 0 auto; }
    section { background: #fff; border: 1px solid #dbe4ee; border-radius: 14px; box-shadow: 0 18px 48px rgba(15, 23, 42, 0.08); padding: 22px; margin-bottom: 16px; }
    h1, h2 { margin: 0 0 8px; }
    h1 { font-size: 26px; }
    h2 { font-size: 19px; }
    p, .hint { color: #64748b; line-height: 1.6; }
    .topbar, .toolbar { display: flex; align-items: center; justify-content: space-between; gap: 14px; flex-wrap: wrap; }
    .top-actions, .row-actions { display: flex; gap: 10px; flex-wrap: wrap; }
    .back-link, button { min-height: 44px; border-radius: 10px; padding: 0 16px; font: inherit; font-weight: 900; cursor: pointer; }
    .back-link { display: inline-flex; align-items: center; color: #0f766e; background: #ecfdf5; border: 1px solid #99f6e4; text-decoration: none; }
    button { border: 0; color: #fff; background: #0f766e; }
    button.secondary { color: #0f766e; background: #ecfdf5; border: 1px solid #99f6e4; }
    button.danger { color: #9f1239; background: #fff1f2; border: 1px solid #fda4af; }
    button:disabled { opacity: .55; cursor: wait; }
    label { display: grid; gap: 8px; max-width: 620px; margin-top: 16px; font-weight: 800; }
    input, select { width: 100%; min-height: 44px; border: 1px solid #cbd5e1; border-radius: 10px; padding: 0 12px; font: inherit; background: #fff; }
    .status { margin-top: 16px; padding: 12px; border-radius: 10px; background: #eff6ff; border: 1px solid #bfdbfe; color: #1e3a8a; line-height: 1.6; white-space: pre-wrap; }
    .status.error { background: #fff1f2; border-color: #fda4af; color: #9f1239; }
    .count { color: #475569; font-weight: 900; }
    .table-wrap { overflow-x: auto; margin-top: 14px; }
    table { width: 100%; border-collapse: collapse; font-size: 14px; }
    th, td { padding: 11px 8px; text-align: left; vertical-align: top; border-bottom: 1px solid #e2e8f0; white-space: nowrap; }
    th { color: #475569; }
    td.message { max-width: 300px; white-space: normal; line-height: 1.5; }
    .row-actions button { min-height: 34px; padding: 0 10px; font-size: 13px; }

    .toolbar { align-items: end; }
    .toolbar label:first-child { flex: 1; min-width: 280px; }
    .quick-filters { display: flex; gap: 8px; flex-wrap: wrap; }
    .quick-filters button.active { color: #fff; background: #0f766e; border-color: #0f766e; }
    table { table-layout: fixed; min-width: 960px; }
    th { background: #f8fafc; font-size: 12px; padding: 13px 10px; }
    td { padding: 18px 10px; white-space: normal; line-height: 1.6; }
    .record-row:hover td { background: #f8fbfc; }
    .account-email { font-weight: 650; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .mono { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 12px; }
    .muted { color: #64748b; font-size: 12px; margin-top: 4px; }
    .copy-inline { padding: 0 2px; min-height: 24px; border-radius: 4px; color: #0f766e; background: transparent; font-size: 12px; font-weight: 500; }
    .state-badge { display: inline-block; padding: 3px 9px; border-radius: 6px; font-size: 12px; font-weight: 650; }
    .state-badge.success { color: #047857; background: #ecfdf5; }
    .state-badge.warning { color: #92400e; background: #fffbeb; }
    .state-badge.progress { color: #1d4ed8; background: #eff6ff; }
    .status-note { font-size: 11px; }
    .sales-channel { display:inline-block; margin-top:7px; padding:2px 7px; border-radius:5px; background:#eef4ff; color:#254887; font-size:11px; font-weight:650; }
    .action-cell, th:last-child { position: sticky; right: 0; background: #fff; box-shadow: -5px 0 8px -8px #64748b; }
    .action-cell .row-actions { gap: 5px; flex-wrap: nowrap; align-items: center; }
    .action-cell button { padding: 0 7px; font-size: 12px; white-space: nowrap; }
    .detail-toggle { color: #475569; background: #f1f5f9; }
    .detail-row td { background: #f8fafc; padding: 20px; }
    .detail-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px 28px; overflow-wrap: anywhere; }
    .detail-label { display: block; color: #64748b; font-size: 12px; margin-bottom: 5px; }
    .detail-actions:not(:empty) { padding-top: 16px; margin-top: 16px; border-top: 1px solid #e2e8f0; }
    .empty { padding: 28px 8px; color: #64748b; text-align: center; }
    .hint { margin: 10px 0 0; font-size: 13px; }
    @media (max-width: 640px) { body { padding: 12px; } section { padding: 16px; } .top-actions > *, .toolbar button { width: 100%; justify-content: center; } }
  </style>
</head>
<body>
  <main>
    <section>
      <div class="topbar">
        <div><h1>充值订单 · 历史记录</h1><p class="hint">查看全部产品与通道的履约记录；有原始资料的订单可在此复制 JSON。</p></div>
      </div>

      <div class="top-actions" style="margin-top:14px"><a href="/admin/pro-orders">Pro 履约工作台</a><button class="secondary" id="syncAccountIds" type="button">同步近 7 天账号 UUID</button><button id="enableAlerts" type="button">开启桌面提醒</button><button class="secondary" id="refresh" type="button">立即刷新</button></div>
      <div class="status" id="statusBox">正在加载充值记录…</div>
    </section>
    <section>
      <div id="cardOrderFilter" class="hint" style="display:none;margin-top:14px">正在查看指定客户卡密的全部订单 <button class="secondary" id="clearCardOrderFilter" type="button">查看全部订单</button></div>
      <div class="quick-filters" id="recordQuickFilters"><button class="secondary" id="filterAll" data-filter="">全部订单</button><button class="secondary" id="filterAttention" data-filter="attention">需要处理</button><button class="secondary" id="filterSuccess" data-filter="success">充值成功</button></div>
      <div class="toolbar"><label>搜索记录<input id="recordSearch" type="search" placeholder="邮箱、UUID、卡密、销售渠道或支付卡尾号"></label><label>状态<select id="statusFilter"><option value="">全部状态</option><option value="attention">需要跟进</option><option value="manual_queued">待人工</option><option value="manual_processing">人工处理中</option><option value="needs_info">需补资料</option><option value="processing">处理中</option><option value="success">成功</option><option value="failed">失败</option><option value="needs_review">待确认</option></select></label><label>充值协议<select id="providerFilter"><option value="">全部协议</option></select></label><label>销售渠道<select id="salesChannelFilter"><option value="">全部渠道</option></select></label><span class="count" id="recoveryCount">0 条</span></div>
      <div class="status" id="cardLookup" style="display:none"></div>
      <p class="hint">人工充值完成后再点击“确认充值成功”；该按钮只更新本站订单和卡密状态，不会再次调用充值通道。自动任务“待确认”时请先核实原任务，不要直接补充充值。</p>
      <div class="table-wrap">
        <table><colgroup><col style="width:25%"><col style="width:22%"><col style="width:9%"><col style="width:17%"><col style="width:12%"><col style="width:15%"></colgroup>
          <thead><tr><th>账号</th><th>客户卡密 / 充值协议</th><th>支付卡</th><th>状态</th><th>提交时间</th><th>操作</th></tr></thead>
          <tbody id="recoveries"><tr><td class="empty" colspan="6">暂无充值记录</td></tr></tbody>
        </table>
      </div>
      <div class="actions"><button class="secondary" id="previousRecords" type="button">上一页</button><span id="recordPage" class="hint">第 1 页</span><button class="secondary" id="nextRecords" type="button">下一页</button></div>
    </section>
  </main>
  <script>
    const statusBox = document.getElementById("statusBox");

    let previousIds = new Set();
    let firstLoad = true;
    let audioContext = null;
    let allRecords = [];
    let selectedCardId = new URLSearchParams(window.location.search).get("cardId") || "";
    let currentPage = 1;
    const recordsPerPage = 50;

    function setStatus(message, error = false) {
      statusBox.textContent = message;
      statusBox.classList.toggle("error", error);
    }
    function escapeHtml(value) {
      return String(value ?? "").replace(/[&<>\"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '\"': "&quot;", "'": "&#39;" }[character]));
    }
    function formatDate(value) {
      if (!value) return "-";
      const date = new Date(value);
      return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString("zh-CN", { hour12: false });
    }
    const api = window.adminApi;
    function statusLabel(status) {
      return ({ manual_queued: "待人工", manual_processing: "人工处理中", needs_info: "需补资料", queued: "自动排队", submitting: "提交中", needs_review: "待确认", failed: "失败", success: "成功", processing: "处理中", syncing: "同步中", created: "已创建" })[status] || status;
    }
    function isPro(item) {
      return ["pro_x5", "pro_x20"].includes(item.plan);
    }
    function canConfirmProManual(item) {
      return isPro(item) && item.fulfillmentMode === "manual" && ["manual_queued", "manual_processing", "needs_info"].includes(item.status);
    }
    function needsFollowup(item) {
      return ["failed", "needs_review", "manual_queued", "manual_processing", "needs_info"].includes(item.status) || item.needsAttention;
    }
    const expandedRecoveryIds = new Set();
    function shortValue(value) {
      const text = String(value || "");
      return text.length > 20 ? text.slice(0, 8) + "…" + text.slice(-7) : text;
    }
    function cardValue(item) {
      return item.customerCardCode || item.customerCardMask || (item.provider === "zzshu" ? "历史卡密未关联" : item.cardMask || "-");
    }
    function renderRecoveryActions(item) {
      return ''
        + (item.provider === 'zzshu' ? '<a class="back-link" href="/admin#zzshu-query">查询 ZZS 开通记录</a>' : '')
        + (canConfirmProManual(item) ? '<button type="button" data-action="mark-pro-success" data-order-id="' + escapeHtml(item.id) + '">确认充值成功</button>' : item.provider === "zzshu" && item.hasUpstreamQueryKey && ["processing", "needs_review"].includes(item.status) ? '<button type="button" data-action="refresh-zzshu" data-order-id="' + escapeHtml(item.id) + '">安全补查</button>' : !isPro(item) && item.provider !== "zzshu" && ["failed", "needs_review"].includes(item.status) ? '<button type="button" data-action="mark-success" data-order-id="' + escapeHtml(item.id) + '">同步成功</button>' : '')
        + (item.provider === 'zzshu' && (item.status === 'needs_review' || item.status === 'processing' && item.hasUpstreamQueryKey) ? '<button class="secondary" type="button" data-action="resolve-zzshu-success" data-order-id="' + escapeHtml(item.id) + '">核实成功</button><button class="secondary" type="button" data-action="resolve-zzshu-unpaid" data-order-id="' + escapeHtml(item.id) + '">核实未支付</button>' : '')
        + (item.provider === 'zzshu' && item.status === 'failed' && item.useResolution === 'frozen' ? '<button class="secondary" type="button" data-action="release-zzshu-use" data-order-id="' + escapeHtml(item.id) + '">释放冻结次数</button><button class="secondary" type="button" data-action="consume-zzshu-use" data-order-id="' + escapeHtml(item.id) + '">记为已消耗</button>' : '')
        + (item.provider === 'zzshu' && item.status === 'success' && item.subscriptionCancellationStatus !== 'cancelled' ? '<button class="secondary" type="button" data-action="confirm-zzshu-cancellation" data-order-id="' + escapeHtml(item.id) + '">核实续费已关闭</button>' : '')
        + (item.needsAttention && item.provider !== 'zzshu' ? '<button type="button" data-action="mark-subscription-handled" data-order-id="' + escapeHtml(item.id) + '">标记已处理</button>' : '')
;
    }
    function renderRows(items) {
      if (!items.length) return '<tr><td class="empty" colspan="6">暂无匹配记录</td></tr>';
      return items.map(item => {
        const id = escapeHtml(item.id);
        const expanded = expandedRecoveryIds.has(item.id);
        const badge = item.status === "success" ? "success" : needsFollowup(item) ? "warning" : "progress";
        const note = item.useResolution === "frozen" ? "本次支付次数已冻结" : item.hifupaySafetyStatus === "confirming_unpaid" ? "安全复核中" : item.subscriptionCancellationStatus === "cancelled" ? "续费已关闭" : item.provider === "zzshu" && item.status === "success" ? "续费状态待同步" : item.provider === "zzshu" && item.status === "needs_review" ? "支付结果待核查" : item.needsAttention ? "需取消续费" : "";
        const message = item.provider === "zzshu" && item.status === "needs_review" ? item.processingNote || item.message : item.needsAttention ? item.subscriptionActionMessage || item.message : item.message;
        const date = formatDate(item.createdAt);
        return '<tr class="record-row">'
          + '<td><div class="account-email" title="' + escapeHtml(item.userEmail || "") + '">' + escapeHtml(item.userEmail || "-") + '</div><div class="muted mono">UUID：' + escapeHtml(shortValue(item.accountId) || "未留存") + (item.accountId ? ' <button class="copy-inline" data-action="copy-uuid" data-order-id="' + id + '" aria-label="复制完整账号 UUID">复制</button>' : '') + '</div></td>'
          + '<td><div class="mono">' + escapeHtml(shortValue(cardValue(item))) + ' <button class="copy-inline" data-action="copy-card" data-order-id="' + id + '" aria-label="复制完整客户卡密">复制</button></div><div class="muted">' + escapeHtml(isPro(item) ? (item.plan === "pro_x5" ? "Pro 5x" : "Pro 20x") : "Plus") + ' · ' + escapeHtml(item.fulfillmentMode === "manual" ? "人工" : ({zzshu:"ZZS",h:"嗨付",hifupay:"嗨付"})[item.provider] || item.provider || "-") + '</div>' + (item.salesChannel ? '<span class="sales-channel">销售渠道：' + escapeHtml(item.salesChannel) + '</span>' : '<span class="muted">销售渠道：未记录</span>') + '</td>'
          + '<td class="mono">' + (item.paymentCardLastFour || item.hifupayCardLastFour ? '****' + escapeHtml(item.paymentCardLastFour || item.hifupayCardLastFour) : '-') + '</td>'
          + '<td><span class="state-badge ' + badge + '">' + escapeHtml(statusLabel(item.status)) + '</span><div class="muted status-note">' + escapeHtml(note) + '</div></td>'
          + '<td><time>' + escapeHtml(date).split(' ').map((part, index) => index ? '<span class="muted">' + part + '</span>' : part).join('<br>') + '</time></td>'
          + '<td class="action-cell"><div class="row-actions">' + (item.hasOriginalJson ? '<button class="secondary" data-action="copy-json" data-order-id="' + id + '">复制 JSON</button>' : '<span class="muted">未留存 JSON</span>') + '<button class="detail-toggle" data-action="toggle-details" data-order-id="' + id + '" aria-expanded="' + expanded + '">' + (expanded ? '收起' : '详情') + '</button></div></td></tr>'
          + (expanded ? '<tr class="detail-row"><td colspan="6"><div class="detail-grid"><div><span class="detail-label">完整账号 UUID</span><div class="mono">' + escapeHtml(item.accountId || "未留存") + '</div></div><div><span class="detail-label">完整客户卡密</span><div class="mono">' + escapeHtml(cardValue(item)) + '</div></div><div><span class="detail-label">销售渠道</span><div>' + escapeHtml(item.salesChannel || "未记录") + '</div></div><div><span class="detail-label">订单编号</span><div class="mono">' + id + '</div></div><div><span class="detail-label">结果说明</span><div>' + escapeHtml(message || "暂无说明") + '</div></div>' + (item.provider === 'zzshu' ? '<div><span class="detail-label">ZZS 上游订单号</span><div class="mono">' + escapeHtml(item.upstreamTaskId || "尚未取得") + '</div></div><div><span class="detail-label">最近查单</span><div>' + escapeHtml(item.lastCheckAt ? formatDate(item.lastCheckAt) + ' · ' + ({paid:'已确认付款',unpaid:'明确未付',processing:'处理中',needs_review:'结果待核查',verification_required:'需要持卡人验证',unknown:'未知结果',api_rejected:'API 凭据被拒绝',upstream_error:'上游接口错误',invalid_response:'响应格式异常',order_mismatch:'订单信息不匹配',network_error:'连接失败或超时'})[item.lastCheckResult] + (item.lastCheckHttpStatus ? ' · HTTP ' + item.lastCheckHttpStatus : '') + (item.lastCheckCode !== null && item.lastCheckCode !== undefined ? ' · code ' + item.lastCheckCode : '') : '尚无查单记录') + '</div></div>' : '') + '</div>' + (item.provider === 'zzshu' && item.status === 'processing' ? '<p class="hint">上游尚未返回明确的已付款结果。可先安全补查；确认外部付款凭据后，再填写核查依据人工结案。</p>' : '') + '<div class="row-actions detail-actions">' + renderRecoveryActions(item) + '</div></td></tr>' : '');
      }).join("");
    }
    async function lookupCardBinding() {
      const input = document.getElementById("recordSearch").value.trim().toUpperCase().match(/HPLUS[0-9A-F]{32}/)?.[0] || "";
      const box = document.getElementById("cardLookup");
      if (!/^HPLUS[0-9A-F]{32}$/.test(input)) { box.style.display = "none"; box.textContent = ""; return; }
      box.style.display = "block";
      box.textContent = "正在查询卡密绑定…";
      try {
        const data = await api("/api/admin/h-cards/query", { method: "POST", body: JSON.stringify({ inputs: [input] }) });
        if (!document.getElementById("recordSearch").value.toUpperCase().includes(input)) return;
        const card = data.results?.[0];
        box.textContent = card?.status === "not_found" ? "本站未找到这张卡密。"
          : card?.status === "invalid" ? "卡密格式不正确。"
            : "卡密状态：" + (card?.statusLabel || card?.status || "未知") + " · 绑定账号：" + (card?.boundAccount || "尚未绑定")
              + " · 充值订单：" + (card?.hasOrder ? "已有订单" : "尚未生成订单")
              + (card?.hasOrder ? "" : "。提交前校验失败也会保留首次账号绑定；请使用原账号重试。")
              + (card?.submittedAt ? " · 首次绑定：" + formatDate(card.submittedAt) : "");
      } catch (error) { box.textContent = "卡密绑定查询失败：" + error.message; }
    }
    function applyRecordFilters() {
      const rawKeyword = document.getElementById("recordSearch").value.trim().toLowerCase();
      const keyword = rawKeyword.match(/hplus[0-9a-f]{32}/)?.[0] || rawKeyword;
      const status = document.getElementById("statusFilter").value;
      const provider = document.getElementById("providerFilter").value;
      const salesChannel = document.getElementById("salesChannelFilter").value;
      const records = allRecords.filter(item => {
        const matchesStatus = !status || (status === "attention" ? needsFollowup(item) : item.status === status);
        return (!selectedCardId || item.customerCardId === selectedCardId)
          && (!keyword || [item.userEmail, item.accountId, item.customerCardCode, item.customerCardMask, item.cardMask, item.paymentCardLastFour, item.hifupayCardLastFour, item.salesChannel, item.id]
            .some(value => String(value || "").toLowerCase().includes(keyword)))
          && matchesStatus && (!provider || item.provider === provider) && (!salesChannel || item.salesChannel === salesChannel);
      });
      for (const [id, value] of [["filterAll", ""], ["filterAttention", "attention"], ["filterSuccess", "success"]]) {
        document.getElementById(id).classList.toggle("active", status === value);
      }
      const pageCount = Math.max(1, Math.ceil(records.length / recordsPerPage));
      currentPage = Math.min(currentPage, pageCount);
      document.getElementById("recoveries").innerHTML = renderRows(records.slice((currentPage - 1) * recordsPerPage, currentPage * recordsPerPage));
      document.getElementById("recoveryCount").textContent = records.length + " / " + allRecords.length + " 条";
      document.getElementById("recordPage").textContent = "第 " + currentPage + " / " + pageCount + " 页";
      document.getElementById("previousRecords").disabled = currentPage <= 1;
      document.getElementById("nextRecords").disabled = currentPage >= pageCount;
    }
    function playAlert() {
      if (!audioContext) return;
      const oscillator = audioContext.createOscillator();
      const gain = audioContext.createGain();
      oscillator.frequency.value = 880;
      gain.gain.value = 0.08;
      oscillator.connect(gain);
      gain.connect(audioContext.destination);
      oscillator.start();
      oscillator.stop(audioContext.currentTime + 0.18);
    }
    function notifyNew(items) {
      const fresh = items.filter(item => !previousIds.has(item.id));
      const alertItems = firstLoad ? fresh.filter(item => item.needsAttention) : fresh;
      if (alertItems.length) {
        playAlert();
        if ("Notification" in window && Notification.permission === "granted") {
          const subscriptionCount = alertItems.filter(item => item.needsAttention).length;
          new Notification(subscriptionCount ? "GPTC 有订单需要跟进" : "GPTC 有新的待处理订单", {
            body: subscriptionCount ? subscriptionCount + " 笔订单需要核查或同步。" : alertItems.length + " 条充值订单需要跟进。"
          });
        }
      }
      previousIds = new Set(items.map(item => item.id));
      firstLoad = false;
    }
    async function loadRecoveries() {
      try {
        const data = await api("/api/admin/recharge-records");
        allRecords = data.records || [];
        const providerSelect = document.getElementById("providerFilter");
        const selectedProvider = providerSelect.value;
        const providers = [...new Set(allRecords.map(item => item.provider).filter(Boolean))].sort();
        providerSelect.innerHTML = '<option value="">全部协议</option>' + providers.map(value => '<option value="' + escapeHtml(value) + '">' + escapeHtml(value) + '</option>').join("");
        providerSelect.value = selectedProvider;
        const channelSelect = document.getElementById("salesChannelFilter");
        const selectedChannel = channelSelect.value;
        const channels = [...new Set(allRecords.map(item => item.salesChannel).filter(Boolean))].sort();
        channelSelect.innerHTML = '<option value="">全部渠道</option>' + channels.map(value => '<option value="' + escapeHtml(value) + '">' + escapeHtml(value) + '</option>').join("");
        channelSelect.value = selectedChannel;
        applyRecordFilters();
        const pending = allRecords.filter(needsFollowup);
        notifyNew(pending);
        setStatus(data.pendingCount ? "共 " + allRecords.length + " 条记录，其中 " + data.pendingCount + " 条需要处理。" : "共 " + allRecords.length + " 条记录，当前没有待处理订单。");
      } catch (error) { setStatus(error.message, true); }
    }
    document.getElementById("enableAlerts").addEventListener("click", async () => {
      try {
        audioContext = new (window.AudioContext || window.webkitAudioContext)();
        await audioContext.resume();
        if ("Notification" in window) await Notification.requestPermission();
        const subscriptionCount = allRecords.filter(item => item.needsAttention).length;
        if (subscriptionCount && "Notification" in window && Notification.permission === "granted") {
          new Notification("GPTC 有订单需要跟进", { body: subscriptionCount + " 笔订单需要核查或同步。" });
        }
        setStatus(subscriptionCount ? "桌面提醒已开启，当前有 " + subscriptionCount + " 笔订单需要跟进。" : "桌面提醒已开启。页面保持打开时，会提示新的待处理订单。", false);
        playAlert();
      } catch (error) { setStatus("提醒开启失败，请检查浏览器通知权限。", true); }
    });
    document.getElementById("refresh").addEventListener("click", loadRecoveries);
    document.getElementById("syncAccountIds").addEventListener("click", async () => {
      const button = document.getElementById("syncAccountIds");
      button.disabled = true;
      try {
        const result = await api("/api/admin/recoveries/sync-account-ids", { method: "POST", body: "{}" });
        await loadRecoveries();
        setStatus("已核对近 7 天 " + result.scanned + " 笔订单，补齐 " + result.updated + " 个账号 UUID；" + result.missing + " 笔没有可恢复的账号 ID。", false);
      } catch (error) { setStatus(error.message || "账号 UUID 同步失败。", true); }
      finally { button.disabled = false; }
    });
    document.getElementById("cardOrderFilter").style.display = selectedCardId ? "block" : "none";
    document.getElementById("clearCardOrderFilter").addEventListener("click", () => {
      selectedCardId = "";
      window.history.replaceState(null, "", "/admin/recoveries");
      document.getElementById("cardOrderFilter").style.display = "none";
      currentPage = 1; applyRecordFilters();
    });
    document.getElementById("recordSearch").addEventListener("input", lookupCardBinding);
    for (const [id, eventName] of [["recordSearch", "input"], ["statusFilter", "change"], ["providerFilter", "change"], ["salesChannelFilter", "change"]]) {
      document.getElementById(id).addEventListener(eventName, () => { currentPage = 1; applyRecordFilters(); });
    }
    document.getElementById("recordQuickFilters").addEventListener("click", event => {
      const button = event.target.closest("[data-filter]");
      if (!button) return;
      document.getElementById("statusFilter").value = button.dataset.filter;
      currentPage = 1; applyRecordFilters();
    });
    document.getElementById("previousRecords").addEventListener("click", () => { currentPage -= 1; applyRecordFilters(); });
    document.getElementById("nextRecords").addEventListener("click", () => { currentPage += 1; applyRecordFilters(); });
    document.getElementById("recoveries").addEventListener("click", async event => {
      const button = event.target.closest("[data-action]");
      if (!button) return;
      const action = button.dataset.action;
      const orderId = button.dataset.orderId;
      const record = allRecords.find(item => item.id === orderId);
      if (!record) { setStatus("订单记录已更新，请刷新后重试。", true); return; }
      if (action === "toggle-details") {
        if (expandedRecoveryIds.has(orderId)) expandedRecoveryIds.delete(orderId);
        else expandedRecoveryIds.add(orderId);
        applyRecordFilters(); return;
      }
      if (action === "copy-uuid" || action === "copy-card") {
        try {
          await navigator.clipboard.writeText(action === "copy-uuid" ? record.accountId || "" : cardValue(record));
          setStatus(action === "copy-uuid" ? "完整账号 UUID 已复制。" : "完整客户卡密已复制。");
        } catch (error) { setStatus("复制失败，请展开详情手动复制。", true); }
        return;
      }
      if (["mark-success", "mark-pro-success"].includes(action)) {
        const plan = record.plan === "pro_x5" ? "Pro 5x" : record.plan === "pro_x20" ? "Pro 20x" : "Plus";
        if (!window.confirm("确认这笔订单已在外部完成充值？\\n账号：" + (record.userEmail || "-") + "\\n套餐：" + plan + "\\n订单：" + orderId + "\\n只同步本站状态，不会再次提交充值。")) return;
      }
      if (action === "mark-subscription-handled" && !window.confirm("确认已经联系用户并完成自动续费处理？")) return;
      button.disabled = true;
      try {
        if (action === "copy-json") {
          const detail = await api("/api/admin/recoveries/" + encodeURIComponent(orderId) + "?reveal=1");
          await navigator.clipboard.writeText(detail.secretJsonText || "");
          setStatus("JSON 已复制到剪贴板，请注意不要转发给无关人员。");
        } else if (action === "refresh-zzshu") {
          const latest = await api("/api/admin/zzshu/orders/" + encodeURIComponent(orderId) + "/refresh", { method: "POST", body: JSON.stringify({}) });
          setStatus(latest.status === record.status ? "已查询上游，状态仍为" + statusLabel(latest.status) + "。" : "已查询上游，订单状态已更新。");
          await loadRecoveries();
        } else if (action.startsWith("resolve-zzshu-")) {
          const outcome = action === "resolve-zzshu-success" ? "success" : "unpaid";
          const reason = window.prompt("请填写至少 8 个字的核查依据（例如上游订单查询结果）。结果不明时请取消，保持订单占用。", "");
          if (reason === null) return;
          if (reason.trim().length < 8) { setStatus("核查依据至少需要 8 个字，订单状态未改变。", true); return; }
          if (!window.confirm("确认该订单" + (outcome === "success" ? "充值成功并核销卡密" : "明确未支付并恢复卡密权益") + "？订单：" + orderId)) return;
          await api("/api/admin/zzshu/orders/" + encodeURIComponent(orderId) + "/resolve", { method: "POST", body: JSON.stringify({ outcome, reason: reason.trim() }) });
          setStatus("人工核查结果已记录，订单状态已更新。");
          await loadRecoveries();
        } else if (action === "release-zzshu-use" || action === "consume-zzshu-use") {
          const outcome = action === "release-zzshu-use" ? "release" : "consume";
          const reason = window.prompt("请填写至少 8 个字的支付卡次数核查依据。", "");
          if (reason === null) return;
          if (reason.trim().length < 8) { setStatus("核查依据至少需要 8 个字，冻结次数未改变。", true); return; }
          if (!window.confirm("确认将这笔订单冻结的支付次数" + (outcome === "release" ? "释放" : "记为已消耗") + "？")) return;
          await api("/api/admin/zzshu/orders/" + encodeURIComponent(orderId) + "/frozen-use", { method: "POST", body: JSON.stringify({ outcome, reason: reason.trim() }) });
          setStatus("支付卡次数处理已记录。");
          await loadRecoveries();
        } else if (action === "confirm-zzshu-cancellation") {
          const reason = window.prompt("确认上游显示续费已关闭后，填写至少 8 个字的核查依据。", "");
          if (reason === null) return;
          if (reason.trim().length < 8) { setStatus("核查依据至少需要 8 个字，订单状态未改变。", true); return; }
          if (!window.confirm("确认这笔订单的自动续费已关闭？订单：" + orderId)) return;
          await api("/api/admin/zzshu/orders/" + encodeURIComponent(orderId) + "/confirm-cancellation", { method: "POST", body: JSON.stringify({ reason: reason.trim() }) });
          setStatus("已记录续费关闭核查结果。");
          await loadRecoveries();
        } else {
          const endpoint = action === "mark-pro-success"
            ? "/api/admin/pro/orders/" + encodeURIComponent(orderId) + "/mark-success"
            : "/api/admin/recoveries/" + encodeURIComponent(orderId) + "/" + (action === "mark-success" ? "mark-success" : "mark-subscription-handled");
          await api(endpoint, { method: "POST", body: JSON.stringify({}) });
          setStatus(["mark-success", "mark-pro-success"].includes(action) ? "已同步为充值成功。" : "已标记为人工处理完成。");
          await loadRecoveries();
        }
      } catch (error) { setStatus(error.message, true); }
      finally { button.disabled = false; }
    });
    loadRecoveries();
    window.setInterval(() => { loadRecoveries(); }, 10000);
  </script>
</body>
</html>`;
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer"
  });
  res.end(html);
}

function assertAdmin(req) {
  return adminAuth.authorize(req);
}

function serveAdminAsset(res, name, contentType = "text/html; charset=utf-8") {
  res.writeHead(200, { "Content-Type": contentType, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY" });
  res.end(fs.readFileSync(path.join(config.rootDir, "admin", name), "utf8"));
}

async function handleAdminAuth(req, res, url) {
  const isAdminPage = url.pathname === "/admin" || url.pathname === "/admin/" || url.pathname.startsWith("/admin/");
  if (!isAdminPage && !url.pathname.startsWith("/api/admin/")) return false;
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Content-Security-Policy", "frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  if (req.method === "GET" && url.pathname === "/admin/session.js") {
    serveAdminAsset(res, "session.js", "application/javascript; charset=utf-8"); return true;
  }
  if (req.method === "GET" && ["/admin/login", "/admin/login/"].includes(url.pathname)) {
    serveAdminAsset(res, "login.html"); return true;
  }
  if (req.method === "POST" && url.pathname === "/api/admin/login") {
    let body;
    try { body = await readJsonBody(req, 4096); }
    catch { sendJson(res, 400, { success: false, message: "登录请求格式不正确。" }); return true; }
    const result = adminAuth.login(req, body);
    if (result.cookie) res.setHeader("Set-Cookie", result.cookie);
    if (result.status === 429) res.setHeader("Retry-After", "900");
    sendJson(res, result.ok ? 200 : result.status, result.ok ? { success: true, data: result.data } : { success: false, message: result.message });
    return true;
  }
  if (isAdminPage) {
    // Legacy credential-bearing links are never authentication, even with a session.
    if (url.searchParams.has("token") || url.searchParams.has("adminToken") || !adminAuth.session(req)) {
      res.writeHead(303, { Location: "/admin/login?next=" + encodeURIComponent(url.pathname) }); res.end(); return true;
    }
    return false;
  }
  const auth = adminAuth.authorize(req);
  if (!auth.ok) { sendJson(res, auth.status, { success: false, message: auth.message }); return true; }
  if (req.method === "GET" && url.pathname === "/api/admin/session") {
    const { csrf, expiresAt, remembered } = auth.session;
    sendJson(res, 200, { success: true, data: { csrf, expiresAt, remembered } }); return true;
  }
  if (req.method === "POST" && ["/api/admin/logout", "/api/admin/logout-all"].includes(url.pathname)) {
    const result = adminAuth.logout(req, url.pathname.endsWith("logout-all"));
    res.setHeader("Set-Cookie", result.cookie);
    sendJson(res, 200, { success: true, data: {} }); return true;
  }
  return false;
}

const hCardQueryRateLimiter = createHCardQueryRateLimiter();
const hifupayReconcileTimers = new Map();
let zzshuReconcileInFlight = false;
let hifupayStatusSyncInFlight = false;

async function runZzshuReconcile() {
  if (zzshuReconcileInFlight) return;
  zzshuReconcileInFlight = true;
  try { await zzshuService.reconcile(); } finally { zzshuReconcileInFlight = false; }
}

async function runHifupayStatusSync() {
  if (hifupayStatusSyncInFlight) return;
  hifupayStatusSyncInFlight = true;
  try { await rechargeService.reconcileHSubscriptionStatuses({ limit: 100 }); }
  finally { hifupayStatusSyncInFlight = false; }
}

function scheduleHifupayOrderReconciliation(orderId, delayMs) {
  const normalizedOrderId = String(orderId || "").trim();
  if (!normalizedOrderId || hifupayReconcileTimers.has(normalizedOrderId)) return false;
  const timer = setTimeout(async () => {
    hifupayReconcileTimers.delete(normalizedOrderId);
    try {
      const result = await rechargeService.reconcileHifupayOrder(normalizedOrderId);
      if (result.confirmationPending) {
        scheduleHifupayOrderReconciliation(
          normalizedOrderId,
          Math.max(Number(config.hifupayFailureConfirmSeconds) || 60, 1) * 1000
        );
      }
    } catch {
      // 网络或上游异常不会释放预留，交由下一次启动/每日兜底复核。
    }
  }, Math.max(Number(delayMs) || 0, 1));
  timer.unref?.();
  hifupayReconcileTimers.set(normalizedOrderId, timer);
  return true;
}

async function reconcileStaleHifupayReservations(limit = 100) {
  const result = await rechargeService.reconcileStaleHifupayReservations({ limit, includeManualReview: true });
  for (const orderId of result.confirmationPendingOrderIds) {
    scheduleHifupayOrderReconciliation(
      orderId,
      Math.max(Number(config.hifupayFailureConfirmSeconds) || 60, 1) * 1000
    );
  }
  return result;
}

let credentialRotationInProgress = false;
let activeRechargeConfirmations = 0;

export const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    if (await handleAdminAuth(req, res, url)) return;

    if (req.method === "OPTIONS" && url.pathname.startsWith("/api/recharge/")) {
      sendJson(res, 200, { success: true });
      return;
    }

    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/activate" || url.pathname === "/activate/")) {
      servePrototype(res);
      return;
    }

    if (req.method === "GET" && (url.pathname === "/admin/provider" || url.pathname === "/admin/provider/")) {
      serveProviderAdmin(res);
      return;
    }

    if (req.method === "GET" && ["/admin", "/admin/"].includes(url.pathname)) {
      serveAdminOverview(res);
      return;
    }

    if (req.method === "GET" && (url.pathname === "/admin/cards/library" || url.pathname === "/admin/cards/library/")) {
      serveHCardLibraryAdmin(res);
      return;
    }

    if (req.method === "GET" && ["/admin/pro-orders", "/admin/pro-orders/"].includes(url.pathname)) {
      serveAdminAsset(res, "pro-orders.html"); return;
    }

    if (req.method === "GET" && url.pathname === "/api/admin/pro/settings") {
      sendJson(res, 200, { success: true, data: proService.settings() }); return;
    }
    if (req.method === "POST" && url.pathname === "/api/admin/pro/settings") {
      const body = await readJsonBody(req);
      const result = proService.updateSettings(body);
      sendJson(res, result.ok ? 200 : 400, result.ok ? { success: true, data: proService.settings() } : { success: false, message: result.message }); return;
    }
    if (req.method === "GET" && url.pathname === "/api/admin/pro/orders") {
      sendJson(res, 200, { success: true, data: { orders: proService.list() } }); return;
    }
    const proOrderRoute = url.pathname.match(/^\/api\/admin\/pro\/orders\/([^/]+)(?:\/(note|manual-processing|needs-info|confirm-no-charge|mark-success|select-card))?$/);
    if (proOrderRoute && req.method === "GET" && !proOrderRoute[2]) {
      const detail = proService.detail(decodeURIComponent(proOrderRoute[1]));
      sendJson(res, detail ? 200 : 404, detail ? { success: true, data: detail } : { success: false, message: "订单不存在。" }); return;
    }
    if (proOrderRoute && req.method === "POST" && proOrderRoute[2]) {
      const body = await readJsonBody(req);
      const result = proOrderRoute[2] === "select-card"
        ? proService.selectCard(decodeURIComponent(proOrderRoute[1]), body.cardId)
        : proOrderRoute[2] === "confirm-no-charge"
        ? await proService.confirmNoCharge(decodeURIComponent(proOrderRoute[1]), body)
        : proService.action(decodeURIComponent(proOrderRoute[1]), proOrderRoute[2], body);
      sendJson(res, result.status, result.ok ? { success: true, data: result.data } : { success: false, message: result.message });
      if (result.ok) proService.drain().catch(() => {});
      return;
    }

    if (req.method === "GET" && (url.pathname === "/admin/cards/batch" || url.pathname === "/admin/cards/batch/")) {
      serveHCardBatchAdmin(res);
      return;
    }

    if (req.method === "GET" && (url.pathname === "/admin/hifupay/cards" || url.pathname === "/admin/hifupay/cards/")) {
      serveHifupayCardAdmin(res);
      return;
    }

    if (req.method === "GET" && (url.pathname === "/admin/zzshu" || url.pathname === "/admin/zzshu/")) {
      res.writeHead(303,{ Location:"/admin/hifupay/cards#importPanel", "Cache-Control":"no-store" });res.end();return;
    }

    if (req.method === "GET" && (url.pathname === "/admin/recoveries" || url.pathname === "/admin/recoveries/")) {
      serveRecoveryAdmin(res);
      return;
    }

    if (req.method === "GET" && (url.pathname === "/admin/cards" || url.pathname === "/admin/cards/")) {
      serveHCardAdmin(res);
      return;
    }

    if (req.method === "GET" && url.pathname === "/admin/provider/switch") {
      res.writeHead(303, { Location: "/admin/provider" });
      res.end();
      return;
    }

    if (req.method === "GET" && url.pathname === "/health") {
      sendJson(res, 200, { ok: true, service: "recharge-center-mvp", provider: rechargeService.getProviderSettings().defaultProvider });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/recharge/provider") {
      sendJson(res, 200, { success: true, data: rechargeService.getProviderSettings() });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/admin/provider") {
      const auth = assertAdmin(req, url);
      if (!auth.ok) {
        sendJson(res, auth.status, { success: false, message: auth.message });
        return;
      }
      sendJson(res, 200, { success: true, data: adminProviderSettings(rechargeService.getProviderSettings()) });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/admin/provider") {
      const body = await readJsonBody(req);
      const auth = assertAdmin(req, url, body);
      if (!auth.ok) {
        sendJson(res, auth.status, { success: false, message: auth.message });
        return;
      }
      const result = rechargeService.updateDefaultProvider(body.provider, "admin");
      sendJson(res, result.status, result.ok ? { success: true, data: adminProviderSettings(result.data) } : { success: false, message: result.message });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/admin/plus-provider") {
      const body = await readJsonBody(req);
      const auth = assertAdmin(req, url, body);
      if (!auth.ok) { sendJson(res, auth.status, { success: false, message: auth.message }); return; }
      const result = rechargeService.updatePlusProvider(body.provider);
      sendJson(res, result.status, result.ok ? { success: true, data: adminProviderSettings(result.data) } : { success: false, message: result.message });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/admin/h-cards") {
      const auth = assertAdmin(req, url);
      if (!auth.ok) {
        sendJson(res, auth.status, { success: false, message: auth.message });
        return;
      }
      const result = rechargeService.listHCards(
        url.searchParams.get("limit") || 100,
        ["1", "true"].includes(url.searchParams.get("all")),
        ["1", "true"].includes(url.searchParams.get("reveal")),
        ["1", "true"].includes(url.searchParams.get("archived"))
      );
      sendJson(res, result.status, { success: true, data: result.data });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/admin/h-cards/query") {
      const body = await readJsonBody(req);
      const auth = assertAdmin(req, url, body);
      if (!auth.ok) {
        sendJson(res, auth.status, { success: false, message: auth.message });
        return;
      }
      try {
        const result = rechargeService.batchQueryHCards(body.inputs);
        sendJson(res, result.status, result.ok ? { success: true, data: result.data } : { success: false, message: result.message });
      } catch {
        sendJson(res, 500, { success: false, message: "批量查询暂不可用，请稍后重试。" });
      }
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/admin/hifupay/cards") {
      const auth = assertAdmin(req, url);
      if (!auth.ok) {
        sendJson(res, auth.status, { success: false, message: auth.message });
        return;
      }
      if (["1", "true"].includes(url.searchParams.get("refresh"))) {
        const refreshed = await rechargeService.refreshHifupayCards();
        if (!refreshed.ok) {
          sendJson(res, refreshed.status || 502, { success: false, message: refreshed.message });
          return;
        }
      }
      const result = rechargeService.listHifupayCards();
      sendJson(res, result.status, { success: true, data: result.data });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/admin/recharge-dashboard") {
      const auth = assertAdmin(req, url);
      if (!auth.ok) { sendJson(res, auth.status, { success: false, message: auth.message }); return; }
      sendJson(res, 200, { success: true, data: rechargeService.getRechargeDashboard() });
      return;
    }

    if (url.pathname.startsWith("/api/admin/hifupay/credential")) {
      let body = {};
      if (req.method === "POST") {
        try { body = await readJsonBody(req, 4096); }
        catch { sendJson(res, 400, { success: false, message: "请求格式不正确。" }); return; }
      }
      const auth = assertAdmin(req, url, body);
      if (!auth.ok) { sendJson(res, auth.status, { success: false, message: auth.message }); return; }
      if (req.method === "GET" && url.pathname === "/api/admin/hifupay/credential") {
        sendJson(res, 200, { success: true, data: hifupayCredentialStore.status() }); return;
      }
      if (req.method === "GET" && url.pathname === "/api/admin/hifupay/credential/check") {
        const result = await hifupayCredentialStore.verifySaved();
        sendJson(res, result.ok ? 200 : result.status, result.ok ? { success: true, data: { accepted: true } } : { success: false, message: result.message }); return;
      }
      if (req.method === "POST" && url.pathname === "/api/admin/hifupay/credential/verify-and-save") {
        if (credentialRotationInProgress || activeRechargeConfirmations > 0) {
          sendJson(res, 409, { success: false, message: "正在提交充值或更换凭据，请稍后重试。" }); return;
        }
        credentialRotationInProgress = true;
        try {
          const dashboard = rechargeService.getRechargeDashboard();
          if (body.replace === true && dashboard.hifupay.processing + dashboard.hifupay.needsReview > 0) {
            sendJson(res, 409, { success: false, message: "嗨付仍有处理中或待核查订单，完成后才能更换 API Key。" }); return;
          }
          const result = await hifupayCredentialStore.verifyAndSave(body.apiKey, { replace: body.replace === true });
          sendJson(res, result.ok ? 200 : result.status, result.ok ? { success: true, data: { configured: true } } : { success: false, message: result.message }); return;
        } finally { credentialRotationInProgress = false; }
      }
      sendJson(res, 404, { success: false, message: "Not found" }); return;
    }

    if (url.pathname.startsWith("/api/admin/zzshu/")) {
      const endpoint = url.pathname.slice("/api/admin/zzshu/".length);
      let body = {};
      if (req.method === "POST") {
        try { body = await readJsonBody(req, endpoint.startsWith("credential") ? 4096 : Infinity); }
        catch { sendJson(res, 400, { success: false, message: "请求格式不正确。" }); return; }
      }
      const auth = assertAdmin(req);
      if (!auth.ok) { sendJson(res,auth.status,{success:false,message:auth.message}); return; }
      try {
        let data;
        if (req.method === "GET" && endpoint === "credential") data = zzshuCredentialStore.status();
        else if (req.method === "GET" && endpoint === "credential/check") {
          const result = await zzshuCredentialStore.verifySaved();
          if (!result.ok) { sendJson(res,result.status,{success:false,message:result.message}); return; }
          data = { accepted: true, points: result.points };
        }
        else if (req.method === "GET" && endpoint === "credential/probe") {
          const result = await zzshuCredentialStore.verify("GPTC-PROBE-INVALID-KEY");
          const browserResult = await zzshuCredentialStore.verify("GPTC-PROBE-INVALID-KEY", {
            "User-Agent": "Mozilla/5.0 (compatible; GPTC-ZZS-Connectivity/1.0)", "Accept": "application/json"
          });
          data = { networkReachable: result.upstreamHttpStatus === 401 && result.upstreamCode === 40107,
            httpStatus: result.upstreamHttpStatus || null, code: result.upstreamCode ?? null,
            browserNetworkReachable: browserResult.upstreamHttpStatus === 401 && browserResult.upstreamCode === 40107,
            browserHttpStatus: browserResult.upstreamHttpStatus || null, browserCode: browserResult.upstreamCode ?? null,
            upstreamRay: String(result.upstreamRay || "").slice(0, 80) };
        }
        else if (req.method === "POST" && endpoint === "credential/verify-and-save") {
          if (credentialRotationInProgress || activeRechargeConfirmations > 0) {
            sendJson(res,409,{success:false,message:"正在提交充值或更换凭据，请稍后重试。"});return;
          }
          credentialRotationInProgress = true;
          try {
            const summary = zzshuService.store.orderSummary();
            if (body.replace === true && summary.processing + summary.needsReview > 0) {
              sendJson(res,409,{success:false,message:"ZZS 旧订单需使用原 Key 查询；仍有处理中或待核查订单，暂不能更换。"});return;
            }
            const result = await zzshuCredentialStore.verifyAndSave(body.apiKey, { replace: body.replace === true });
            if (!result.ok) { sendJson(res, result.status, { success: false, message: result.message }); return; }
            data = { configured: true, points: result.points ?? null, channelEnabled: config.zzshuEnabled };
          } finally { credentialRotationInProgress = false; }
        }
        else if (req.method === "GET" && endpoint === "usage") {
          const page = Number(url.searchParams.get("page") || 1);
          if (!Number.isInteger(page) || page < 1 || page > 1000) { sendJson(res,400,{success:false,message:"页码无效"});return; }
          const result = await zzshuAdapter.usage(page);
          if (!result.ok) { sendJson(res,502,{success:false,message:`ZZS 上游查询失败（HTTP ${result.status || "?"}，code ${result.code ?? "?"}）`});return; }
          data = result.data;
        }
        else if (req.method === "GET" && endpoint === "import-status") data = zzshuService.importStatus();
        else if (req.method === "GET" && endpoint === "diagnostics") data = zzshuService.diagnostics();
        else if (req.method === "GET" && endpoint === "cards") data = zzshuService.store.listCards();
        else if (req.method === "GET" && endpoint === "hifupay-cards") data = await zzshuService.listHifupayAssignments(["1","true"].includes(url.searchParams.get("refresh")));
        else if (req.method === "POST" && /^hifupay-cards\/[^/]+\/assign$/.test(endpoint)) {
          const id=decodeURIComponent(endpoint.split("/")[1]), result=zzshuService.assignHifupayCard(id,body.role);
          if (!result.ok) {sendJson(res,409,{success:false,message:result.reason});return;} data=result;
        } else if (req.method === "GET" && endpoint === "vouchers") data = zzshuService.store.listVouchers();
        else if (req.method === "GET" && endpoint === "orders") data = zzshuService.store.listOrders();
        else if (req.method === "POST" && endpoint === "preview") data = zzshuService.preview(body.text);
        else if (req.method === "POST" && endpoint === "import") { const result=await zzshuService.importCards(body); if(!result.ok){sendJson(res,400,{success:false,message:result.message});return;} data=result.rows; }
        else if (req.method === "POST" && endpoint === "vouchers") data = zzshuService.createVouchers(body);
        else if (req.method === "POST" && /^cards\/[^/]+$/.test(endpoint)) { const id=decodeURIComponent(endpoint.split("/")[1]); if(!zzshuService.store.updateCard(id,body)){sendJson(res,400,{success:false,message:"卡片不存在或次数上限无效"});return;} data={ok:true}; }
        else if (req.method === "POST" && /^cards\/[^/]+\/retire$/.test(endpoint)) { const id=decodeURIComponent(endpoint.split("/")[1]), result=zzshuService.store.retireManualCard(id); if(!result.ok){sendJson(res,409,{success:false,message:result.reason});return;} data={ok:true}; }
        else if (req.method === "POST" && /^orders\/[^/]+\/refresh$/.test(endpoint)) { const result=await zzshuService.refresh(decodeURIComponent(endpoint.split("/")[1])); data=result.data; }
        else if (req.method === "POST" && /^orders\/[^/]+\/resolve$/.test(endpoint)) { const id=decodeURIComponent(endpoint.split("/")[1]); if(!["success","unpaid"].includes(body.outcome)||!zzshuService.store.manualResolve(id,body.outcome,String(body.reason||""))){sendJson(res,409,{success:false,message:"仅已创建上游任务的处理中或待确认订单可凭至少 8 字核查依据人工结案"});return;} zzshuService.syncUnifiedOrder(id); data={ok:true}; }
        else if (req.method === "POST" && /^orders\/[^/]+\/frozen-use$/.test(endpoint)) { const id=decodeURIComponent(endpoint.split("/")[1]); if(!zzshuService.store.resolveFrozenUse(id,body.outcome,body.reason)){sendJson(res,409,{success:false,message:"仅冻结中的支付次数可凭至少 8 字核查依据处理"});return;} data={ok:true}; }
        else if (req.method === "POST" && /^orders\/[^/]+\/confirm-cancellation$/.test(endpoint)) { const id=decodeURIComponent(endpoint.split("/")[1]); if(!zzshuService.store.confirmCancellation(id,String(body.reason||""))){sendJson(res,409,{success:false,message:"仅成功订单可凭至少 8 字核查依据确认续费关闭"});return;} data={ok:true}; }
        else { sendJson(res,404,{success:false,message:"Not found"}); return; }
        sendJson(res,200,{success:true,data});
      } catch { sendJson(res,503,{success:false,message:"ZZS 管理操作未完成，请检查服务配置"}); }
      return;
    }

    const hifupayCardAction = url.pathname.match(/^\/api\/admin\/hifupay\/cards\/([^/]+)\/(disable|enable|release|settings|protect-pro|release-pro)$/);
    if (req.method === "POST" && hifupayCardAction) {
      const body = await readJsonBody(req);
      const auth = assertAdmin(req, url, body);
      if (!auth.ok) {
        sendJson(res, auth.status, { success: false, message: auth.message });
        return;
      }
      const cardId = decodeURIComponent(hifupayCardAction[1]);
      const action = hifupayCardAction[2];
      const result = action === "protect-pro"
        ? rechargeService.protectHifupayCardForPro(cardId, body)
        : action === "release-pro"
          ? rechargeService.releaseHifupayCardProProtection(cardId)
        : action === "release"
        ? rechargeService.clearHifupayReservation(cardId, body.orderId, body.reason)
        : action === "settings"
          ? (body.field === "priority"
            ? rechargeService.setHifupayCardPriority(cardId, body.value)
            : body.field === "maxUses" ? rechargeService.setHifupayCardMaxUses(cardId, body.value)
            : { ok: false, status: 400, message: "不支持的卡片设置。" })
        : rechargeService.setHifupayCardEnabled(cardId, action === "enable");
      sendJson(res, result.status, result.ok ? { success: true, data: result.data } : { success: false, message: result.message });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/admin/recoveries") {
      const auth = assertAdmin(req, url);
      if (!auth.ok) {
        sendJson(res, auth.status, { success: false, message: auth.message });
        return;
      }
      const result = rechargeService.listRecoverySubmissions();
      sendJson(res, result.status, { success: true, data: result.data });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/admin/recoveries/sync-account-ids") {
      const body = await readJsonBody(req);
      const auth = assertAdmin(req, url, body);
      if (!auth.ok) { sendJson(res, auth.status, { success: false, message: auth.message }); return; }
      sendJson(res, 200, { success: true, data: rechargeService.syncRecentAccountIds() });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/admin/recharge-records") {
      const auth = assertAdmin(req, url);
      if (!auth.ok) {
        sendJson(res, auth.status, { success: false, message: auth.message });
        return;
      }
      const result = rechargeService.listRechargeSubmissions();
      sendJson(res, result.status, { success: true, data: result.data });
      return;
    }

    const recoveryDetail = url.pathname.match(/^\/api\/admin\/recoveries\/([^/]+)$/);
    if (req.method === "GET" && recoveryDetail) {
      const auth = assertAdmin(req, url);
      if (!auth.ok) {
        sendJson(res, auth.status, { success: false, message: auth.message });
        return;
      }
      const result = rechargeService.getRecoverySubmission(
        decodeURIComponent(recoveryDetail[1]),
        ["1", "true"].includes(url.searchParams.get("reveal"))
      );
      sendJson(res, result.status, result.ok ? { success: true, data: result.data } : { success: false, message: result.message });
      return;
    }

    const recoveryAction = url.pathname.match(/^\/api\/admin\/recoveries\/([^/]+)\/(mark-success|mark-subscription-handled)$/);
    if (req.method === "POST" && recoveryAction) {
      const body = await readJsonBody(req);
      const auth = assertAdmin(req, url, body);
      if (!auth.ok) {
        sendJson(res, auth.status, { success: false, message: auth.message });
        return;
      }
      const orderId = decodeURIComponent(recoveryAction[1]);
      const action = recoveryAction[2];
      const result = action === "mark-success"
        ? rechargeService.markRecoverySuccess(orderId, "admin", body.message || "人工充值成功，系统已同步完成。")
        : rechargeService.markHSubscriptionHandled(orderId, "admin");
      sendJson(res, result.status, result.ok ? { success: true, data: result.data } : { success: false, message: result.message, data: result.data });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/admin/h-cards") {
      const body = await readJsonBody(req);
      const auth = assertAdmin(req, url, body);
      if (!auth.ok) {
        sendJson(res, auth.status, { success: false, message: auth.message });
        return;
      }
      const result = rechargeService.createHCards(body);
      sendJson(res, result.status, result.ok ? { success: true, data: result.data } : { success: false, message: result.message });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/admin/h-cards/bulk") {
      const body = await readJsonBody(req);
      const auth = assertAdmin(req, url, body);
      if (!auth.ok) {
        sendJson(res, auth.status, { success: false, message: auth.message });
        return;
      }
      const result = rechargeService.bulkHCardAction(body.cardIds, body.action);
      sendJson(res, result.status, { success: true, data: result.data });
      return;
    }

    const hCardAction = url.pathname.match(/^\/api\/admin\/h-cards\/([^/]+)\/(unlock|disable|enable|archive|restore|delete)$/);
    if (req.method === "POST" && hCardAction) {
      const body = await readJsonBody(req);
      const auth = assertAdmin(req, url, body);
      if (!auth.ok) {
        sendJson(res, auth.status, { success: false, message: auth.message });
        return;
      }
      const cardId = decodeURIComponent(hCardAction[1]);
      const action = hCardAction[2];
      const result = action === "unlock"
        ? rechargeService.unlockHCard(cardId)
        : action === "archive" || action === "restore"
          ? rechargeService.archiveHCard(cardId, action === "archive")
          : action === "delete"
            ? rechargeService.deleteHCard(cardId)
            : rechargeService.setHCardDisabled(cardId, action === "disable", body.reason);
      sendJson(res, result.status, result.ok ? { success: true, data: result.data } : { success: false, message: result.message });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/recharge/verify-card") {
      const body = await readJsonBody(req);
      const result = await rechargeService.verifyCard(body.cardInfo, body.provider);
      sendJson(res, result.status, result.ok ? { success: true, data: result.data } : { success: false, message: result.data?.message || result.message || "验卡失败。", data: result.data });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/recharge/h-card-status") {
      const rate = hCardQueryRateLimiter.check(req);
      if (!rate.ok) {
        res.setHeader("Retry-After", String(rate.retryAfter));
        sendJson(res, 429, { success: false, message: "查询过于频繁，请稍后再试。" });
        return;
      }
      try {
        const body = await readJsonBody(req);
        const result = await rechargeService.queryHCardStatus(body.cardInfo, body.provider);
        sendJson(res, result.status, result.ok ? { success: true, data: result.data } : { success: false, message: result.message });
      } catch {
        sendJson(res, 500, { success: false, message: "卡密状态查询暂不可用，请稍后重试。" });
      }
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/recharge/pro-order-status") {
      const rate = hCardQueryRateLimiter.check(req);
      if (!rate.ok) { sendJson(res, 429, { success: false, message: "查询过于频繁，请稍后再试。" }); return; }
      const body = await readJsonBody(req);
      const result = await proService.query(body);
      sendJson(res, result.status, result.ok ? { success: true, data: result.data } : { success: false, message: result.message }); return;
    }

    if (req.method === "POST" && url.pathname === "/api/recharge/query-card-status") {
      const body = await readJsonBody(req);
      const result = await rechargeService.queryCardStatus(body.cardInfo, body.provider);
      sendJson(res, result.status, result.ok ? { success: true, data: result.data } : { success: false, message: result.message || "卡密状态查询失败。", data: result.data });
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
      if (credentialRotationInProgress) {
        sendJson(res, 503, { success: false, message: "充值通道正在更新，请稍后重新提交。" }); return;
      }
      activeRechargeConfirmations += 1;
      let result;
      try { result = await rechargeService.confirmRecharge(body); }
      finally { activeRechargeConfirmations -= 1; }
      for (const orderId of result.hifupaySafetyPendingOrderIds || []) {
        scheduleHifupayOrderReconciliation(
          orderId,
          Math.max(Number(config.hifupayFailureConfirmSeconds) || 60, 1) * 1000
        );
      }
      if (result.ok && result.data?.provider === "h" && result.data?.orderId && result.data?.taskId) {
        scheduleHifupayOrderReconciliation(
          result.data.orderId,
          Math.max(Number(config.hifupayStaleReservationMinutes) || 10, 1) * 60 * 1000
        );
      }
      sendJson(res, result.status, result.ok ? { success: true, data: result.data } : { success: false, message: result.message || "充值提交失败。", data: result.data });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/recharge/query-task-status") {
      const body = await readJsonBody(req);
      const result = await rechargeService.queryTaskStatus(body);
      sendJson(res, result.status, result.ok ? { success: true, data: result.data } : { success: false, message: result.message || "状态查询失败。", data: result.data });
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

const isMainModule = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMainModule) {
  try { rechargeService.syncRecentAccountIds(); } catch { /* Keep existing orders untouched if the local data file is unavailable. */ }
  proService.recoverOnStart();
  server.listen(config.port, config.host, () => {
    console.log(`Recharge center MVP listening on http://${config.host}:${config.port}`);
  });
  const initialSyncTimer = setTimeout(() => {
    runZzshuReconcile().catch(() => {});
    runHifupayStatusSync().catch(() => {
      // 旧订阅记录纠正失败不影响服务启动。
    });
    reconcileStaleHifupayReservations().catch(() => {
      // 资金卡预留状态不明确时保持占用，等待下次安全复核。
    });
  }, 5000);
  initialSyncTimer.unref?.();
  const proTimer = setInterval(() => { proService.reconcile().catch(() => {}); }, 10000);
  proTimer.unref?.();
  proService.reconcile().catch(() => {});
  const zzshuTimer = setInterval(() => runZzshuReconcile().catch(() => {}), Math.max(2000,config.zzshuPollMs));
  zzshuTimer.unref?.();
  const hifupayStatusTimer = setInterval(() => runHifupayStatusSync().catch(() => {}), Math.max(15000,config.hifupayStatusPollMs));
  hifupayStatusTimer.unref?.();
  const dailyReconcileTimer = setInterval(() => {
    reconcileStaleHifupayReservations().catch(() => {
      // 每日兜底失败不会释放任何预留。
    });
  }, Math.max(Number(config.hifupayReconcileIntervalHours) || 24, 1) * 60 * 60 * 1000);
  dailyReconcileTimer.unref?.();
}
