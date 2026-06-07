import crypto from "node:crypto";

const PANEL_BASE = process.env.PANEL_BASE;
const PANEL_ENTRANCE = process.env.PANEL_ENTRANCE;
const PANEL_USER = process.env.PANEL_USER;
const PANEL_PASS = process.env.PANEL_PASS;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;
const API_PREFIX = "/api/v1";

for (const [name, value] of Object.entries({
  PANEL_BASE,
  PANEL_ENTRANCE,
  PANEL_USER,
  PANEL_PASS,
  ADMIN_TOKEN
})) {
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
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
      throw new Error(`Panel request failed (${response.status}): ${text}`);
    }
    if (parsed?.code && parsed.code !== 200) {
      throw new Error(`Panel API failed (${parsed.code}): ${parsed.message || text}`);
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
      throw new Error(`1Panel login did not return session credentials: ${JSON.stringify(result)}`);
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

function envFileValue(value) {
  const normalized = String(value);
  if (/[\r\n]/.test(normalized)) {
    throw new Error("Environment file values must not contain newlines");
  }
  return normalized;
}

function buildDeployScript() {
  const adminToken = envFileValue(ADMIN_TOKEN);
  return `#!/bin/sh
set -eu

APP_ROOT="/opt/gptc-recharge"
APP_DIR="$APP_ROOT/gptccc"
DATA_ROOT="$APP_ROOT/runtime"
ENV_FILE="$APP_ROOT/recharge-center.env"
REPO_URL="https://github.com/jack12202/gptccc.git"
CONTAINER_NAME="gptc-recharge-center"

echo "[gptc] preparing directories"
mkdir -p "$APP_ROOT" "$DATA_ROOT/data" "$DATA_ROOT/logs"

if command -v git >/dev/null 2>&1; then
  if [ -d "$APP_DIR/.git" ]; then
    echo "[gptc] updating repository"
    git -C "$APP_DIR" fetch --depth=1 origin main
    git -C "$APP_DIR" reset --hard origin/main
  else
    echo "[gptc] cloning repository"
    rm -rf "$APP_DIR"
    git clone --depth=1 "$REPO_URL" "$APP_DIR"
  fi
else
  echo "[gptc] git not found, using archive download"
  TMP_DIR="$(mktemp -d)"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "https://github.com/jack12202/gptccc/archive/refs/heads/main.tar.gz" -o "$TMP_DIR/main.tar.gz"
  else
    wget -qO "$TMP_DIR/main.tar.gz" "https://github.com/jack12202/gptccc/archive/refs/heads/main.tar.gz"
  fi
  rm -rf "$APP_DIR"
  mkdir -p "$APP_DIR"
  tar -xzf "$TMP_DIR/main.tar.gz" -C "$TMP_DIR"
  cp -R "$TMP_DIR"/gptccc-main/. "$APP_DIR"/
  rm -rf "$TMP_DIR"
fi

cat > "$ENV_FILE" <<'EOF'
HOST=0.0.0.0
PORT=8788
DEFAULT_PROVIDER=sange
ADMIN_TOKEN=${adminToken}
AYAN_BASE_URL=https://api.987ai.vip
UPSTREAM_BASE_URL=https://kkk.ow800.com
DATA_FILE=/app/data/orders.json
LOG_FILE=/app/logs/server.log
EOF
chmod 600 "$ENV_FILE"

if command -v docker >/dev/null 2>&1; then
  echo "[gptc] starting backend with Docker"
  docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
  docker run -d \\
    --name "$CONTAINER_NAME" \\
    --restart unless-stopped \\
    -p 127.0.0.1:8788:8788 \\
    --env-file "$ENV_FILE" \\
    -v "$APP_DIR/recharge-center":/app \\
    -v "$DATA_ROOT/data":/app/data \\
    -v "$DATA_ROOT/logs":/app/logs \\
    -w /app \\
    node:22-alpine \\
    node src/server.js
else
  echo "[gptc] starting backend with host Node"
  pkill -f "gptc-recharge-center.*src/server.js" >/dev/null 2>&1 || true
  set -a
  . "$ENV_FILE"
  set +a
  nohup node "$APP_DIR/recharge-center/src/server.js" > "$DATA_ROOT/logs/nohup.log" 2>&1 &
fi

echo "[gptc] waiting for backend health"
for i in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:8788/health >/tmp/gptc-recharge-health.json 2>/tmp/gptc-recharge-health.err; then
    cat /tmp/gptc-recharge-health.json
    echo
    break
  fi
  if [ "$i" = "30" ]; then
    echo "[gptc] backend health failed"
    cat /tmp/gptc-recharge-health.err 2>/dev/null || true
    if command -v docker >/dev/null 2>&1; then docker logs "$CONTAINER_NAME" || true; fi
    exit 1
  fi
  sleep 2
done

PROXY_DIR="/opt/1panel/apps/openresty/openresty/www/sites/gptc.cc/proxy"
PROXY_FILE="$PROXY_DIR/gptc-recharge-center.conf"
if [ ! -d "$PROXY_DIR" ]; then
  echo "[gptc] proxy directory not found: $PROXY_DIR"
  exit 1
fi

echo "[gptc] writing OpenResty proxy include"
cat > "$PROXY_FILE" <<'EOF'
location ^~ /api/recharge/ {
    proxy_pass http://127.0.0.1:8788;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}

location = /api/admin/provider {
    proxy_pass http://127.0.0.1:8788;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}

location = /admin/provider {
    proxy_pass http://127.0.0.1:8788;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}

location ^~ /admin/provider/ {
    proxy_pass http://127.0.0.1:8788;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
EOF

if command -v docker >/dev/null 2>&1; then
  OPENRESTY_CONTAINER="$(docker ps --format '{{.Names}}' | grep -E 'openresty|1panel-openresty' | head -n1 || true)"
else
  OPENRESTY_CONTAINER=""
fi

echo "[gptc] testing and reloading OpenResty"
if [ -n "$OPENRESTY_CONTAINER" ]; then
  docker exec "$OPENRESTY_CONTAINER" nginx -t || docker exec "$OPENRESTY_CONTAINER" openresty -t
  docker exec "$OPENRESTY_CONTAINER" nginx -s reload || docker exec "$OPENRESTY_CONTAINER" openresty -s reload
else
  if command -v openresty >/dev/null 2>&1; then
    openresty -t
    openresty -s reload
  else
    nginx -t
    nginx -s reload
  fi
fi

echo "[gptc] deployment finished"
`;
}

async function waitForCompletion(client, cronjobID) {
  const startedAt = Date.now();
  let latestRecordId = null;
  let latestStatus = "";
  let latestLog = "";

  while (Date.now() - startedAt < 10 * 60 * 1000) {
    const records = await client.searchRecords(cronjobID);
    if (records.length) {
      const latest = records[0];
      latestRecordId = latest.id;
      latestStatus = latest.status || "";
      latestLog = latest.records ? await client.readRecordLog(latest.id) : latestLog;
      if (latestStatus === "Success") {
        console.log(latestLog);
        return;
      }
      if (latestStatus === "Failed") {
        console.log(latestLog);
        throw new Error(`Recharge backend deploy task failed, record ${latestRecordId}`);
      }
    }
    await new Promise(resolve => setTimeout(resolve, 5000));
  }

  if (latestLog) console.log(latestLog);
  throw new Error(`Timed out waiting for recharge backend deploy task. Last status: ${latestStatus || "none"}`);
}

async function main() {
  const client = new PanelClient();
  await client.login();

  const taskName = "gptc-recharge-deploy";
  const existing = await client.searchCronjobs(taskName);
  const matchingIds = existing
    .filter(item => item.name === taskName)
    .map(item => item.id)
    .filter(Boolean);
  await client.deleteCronjobs(matchingIds);

  await client.createCronjob({
    name: taskName,
    type: "shell",
    spec: "30 1 * * 1",
    specObjs: [{ specType: "perWeek", week: 1, day: 0, hour: 1, minute: 30, second: 0 }],
    command: "sh",
    script: buildDeployScript(),
    retainCopies: 3,
    status: "Enable",
    defaultDownload: "LOCAL",
    backupAccounts: "LOCAL",
    backupAccountList: ["LOCAL"],
    inContainer: false,
    containerName: "",
    hasAlert: false,
    alertCount: 0,
    alertTitle: ""
  });

  const created = await client.searchCronjobs(taskName);
  const task = created.find(item => item.name === taskName);
  if (!task?.id) {
    throw new Error("Created cronjob was not found");
  }

  console.log(`Running 1Panel cronjob ${taskName} (${task.id})`);
  await client.runCronjob(task.id);
  await waitForCompletion(client, task.id);
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
