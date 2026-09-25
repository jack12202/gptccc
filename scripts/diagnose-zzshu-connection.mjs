import crypto from "node:crypto";
import fs from "node:fs";
const { PANEL_BASE, PANEL_ENTRANCE, PANEL_USER, PANEL_PASS } = process.env;
const API_PREFIX = "/api/v1";
for (const [name,value] of Object.entries({ PANEL_BASE, PANEL_ENTRANCE, PANEL_USER, PANEL_PASS })) {
  if (!value) throw new Error(`Missing ${name}`);
}
class PanelClient {
  constructor() {
    this.cookies = new Map();
    this.token = "";
  }

  cookieHeader() {
    return Array.from(this.cookies.entries())
      .map(([key, value]) => `${key}=${value}`)
      .join("; ");
  }

  storeSetCookie(headers) {
    const setCookies = headers.getSetCookie?.() || [];
    for (const line of setCookies) {
      const pair = line.split(";", 1)[0];
      const idx = pair.indexOf("=");
      if (idx > 0) {
        this.cookies.set(pair.slice(0, idx), pair.slice(idx + 1));
      }
    }
  }

  async request(pathname, { method = "GET", headers = {}, body } = {}) {
    const finalHeaders = {
      EntranceCode: Buffer.from(PANEL_ENTRANCE).toString("base64"),
      ...headers
    };
    if (this.token) {
      finalHeaders.Authorization = this.token;
      finalHeaders["1Panel-Token"] = this.token;
      finalHeaders["X-Panel-Token"] = this.token;
      finalHeaders["X-Token"] = this.token;
    }
    const cookie = this.cookieHeader();
    if (cookie) finalHeaders.Cookie = cookie;

    const response = await fetch(`${PANEL_BASE}${pathname}`, {
      method,
      headers: finalHeaders,
      body
    });
    this.storeSetCookie(response.headers);

    const text = await response.text();
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
    if (!response.ok) {
      throw new Error(`Panel request failed (${response.status})`);
    }
    if (parsed?.code && parsed.code !== 200) {
      throw new Error(`Panel API failed (${parsed.code})`);
    }
    return parsed;
  }

  async init() {
    await this.request(`/${PANEL_ENTRANCE}`);
  }

  get panelPublicKeyPem() {
    const encoded = this.cookies.get("panel_public_key");
    if (!encoded) throw new Error("panel_public_key cookie missing");
    return Buffer.from(decodeURIComponent(encoded), "base64").toString("utf8");
  }

  encryptPassword(plain) {
    const aesKeyHex = crypto.randomBytes(16).toString("hex");
    const iv = crypto.randomBytes(16);
    const rsaCipher = crypto.publicEncrypt(
      {
        key: this.panelPublicKeyPem,
        padding: crypto.constants.RSA_PKCS1_PADDING
      },
      Buffer.from(aesKeyHex, "utf8")
    ).toString("base64");

    const cipher = crypto.createCipheriv(
      "aes-256-cbc",
      Buffer.from(aesKeyHex, "utf8"),
      iv
    );
    const encrypted = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]).toString("base64");
    return `${rsaCipher}:${iv.toString("base64")}:${encrypted}`;
  }

  async login() {
    await this.init();
    const result = await this.request(`${API_PREFIX}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: PANEL_USER,
        password: this.encryptPassword(PANEL_PASS),
        authMethod: "session",
        language: "zh"
      })
    });
    if (result?.data?.token) {
      this.token = result.data.token;
    }
    if (!this.token && this.cookies.size === 0) {
      throw new Error("1Panel login did not return session credentials");
    }
  }

  async searchCronjobs(info = "") {
    const result = await this.request(`${API_PREFIX}/cronjobs/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        info,
        page: 1,
        pageSize: 50,
        orderBy: "created_at",
        order: "null"
      })
    });
    return result?.data?.items || [];
  }

  async deleteCronjobs(ids) {
    if (!ids.length) return;
    await this.request(`${API_PREFIX}/cronjobs/del`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids, cleanData: true, cleanRemoteData: true })
    });
  }

  async createCronjob(payload) {
    const result = await this.request(`${API_PREFIX}/cronjobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    return result?.data;
  }

  async runCronjob(id) {
    await this.request(`${API_PREFIX}/cronjobs/handle`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id })
    });
  }

  async searchRecords(cronjobID) {
    const result = await this.request(`${API_PREFIX}/cronjobs/search/records`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        page: 1,
        pageSize: 10,
        cronjobID,
        startTime: new Date(Date.now() - 15 * 60 * 1000).toISOString(),
        endTime: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
        status: ""
      })
    });
    return result?.data?.items || [];
  }

  async readRecordLog(id) {
    const result = await this.request(`${API_PREFIX}/cronjobs/records/log`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id })
    });
    return (result?.data || "").replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "").replace(/\r/g, "");
  }
}

async function main() {
  const client = new PanelClient();
  await client.login();
  const name = `gptc-zzs-readonly-${process.env.GITHUB_RUN_ID || Date.now()}`;
  const probe = fs.readFileSync(new URL('./zzshu-network-probe.mjs',import.meta.url),'utf8');
  const script = `#!/bin/sh
set -eu
date -u '+diagnostic_time=%Y-%m-%dT%H:%M:%SZ'
docker exec -i -w /app gptc-recharge-center node --input-type=module <<'GPTC_READONLY_NODE'
${probe}
GPTC_READONLY_NODE
curl -4 --http1.1 -sS --max-time 25 -o /dev/null -w 'host_http1_status=%{http_code} remote=%{remote_ip} seconds=%{time_total}\\n' -H 'X-API-Key: GPTC-PROBE-INVALID-KEY' https://card.zzshu.pro/api/v1/third-party/user || true
curl -4 --http2 -sS --max-time 25 -o /dev/null -w 'host_http2_status=%{http_code} remote=%{remote_ip} seconds=%{time_total}\\n' -H 'X-API-Key: GPTC-PROBE-INVALID-KEY' https://card.zzshu.pro/api/v1/third-party/user || true
`;
  let task;
  try {
    await client.createCronjob({name,type:'shell',spec:'0 0 1 1 *',specObjs:[{specType:'perMonth',day:1,hour:0,minute:0,second:0}],command:'sh',script,
      retainCopies:1,status:'Disable',defaultDownload:'LOCAL',backupAccounts:'LOCAL',backupAccountList:['LOCAL'],inContainer:false,containerName:'',hasAlert:false,alertCount:0,alertTitle:''});
    task = (await client.searchCronjobs(name)).find(x=>x.name===name);
    if (!task?.id) throw Error('Diagnostic task unavailable');
    await client.runCronjob(task.id);
    const started=Date.now();
    while(Date.now()-started<240000){
      const record=(await client.searchRecords(task.id))[0];
      if(record && ['Success','Failed'].includes(record.status)){
        console.log(await client.readRecordLog(record.id));
        if(record.status==='Failed')throw Error('Remote diagnosis failed');
        return;
      }
      await new Promise(resolve=>setTimeout(resolve,5000));
    }
    throw Error('Remote diagnosis timed out');
  } finally {
    const ownTasks=(await client.searchCronjobs(name)).filter(x=>x.name===name).map(x=>x.id);
    await client.deleteCronjobs(ownTasks);
  }
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
