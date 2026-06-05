import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const PANEL_BASE = process.env.PANEL_BASE;
const PANEL_ENTRANCE = process.env.PANEL_ENTRANCE;
const PANEL_USER = process.env.PANEL_USER;
const PANEL_PASS = process.env.PANEL_PASS;
const PANEL_TARGET_DIR = process.env.PANEL_TARGET_DIR;

const API_PREFIX = "/api/v1";

for (const [name, value] of Object.entries({
  PANEL_BASE,
  PANEL_ENTRANCE,
  PANEL_USER,
  PANEL_PASS,
  PANEL_TARGET_DIR
})) {
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
}

const repoRoot = process.cwd();

class PanelClient {
  constructor() {
    this.cookies = new Map();
    this.token = "";
  }

  cookieHeader() {
    return Array.from(this.cookies.entries())
      .map(([k, v]) => `${k}=${v}`)
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
    const payload = {
      name: PANEL_USER,
      password: this.encryptPassword(PANEL_PASS),
      authMethod: "session",
      language: "zh"
    };
    const result = await this.request(`${API_PREFIX}/auth/login`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });
    if (result?.data?.token) {
      this.token = result.data.token;
    }
    if (!this.token && this.cookies.size === 0) {
      throw new Error(`1Panel login did not return session credentials: ${JSON.stringify(result)}`);
    }
  }

  async saveTextFile(remoteFile, content) {
    const payload = {
      path: remoteFile,
      content
    };
    const result = await this.request(`${API_PREFIX}/files/save`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });
    if (result?.code !== 200) {
      throw new Error(`Failed to save ${remoteFile}: ${JSON.stringify(result)}`);
    }
  }
}

function walkTextFiles(dir) {
  const result = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      result.push(...walkTextFiles(fullPath));
      continue;
    }
    if (entry.name.endsWith(".html")) {
      result.push(fullPath);
    }
  }
  return result.sort();
}

function toRemotePath(localFile) {
  const rel = path.relative(repoRoot, localFile).replaceAll(path.sep, "/");
  return `${PANEL_TARGET_DIR}/${rel}`;
}

async function main() {
  const client = new PanelClient();
  await client.login();

  const staticFiles = [
    "index.html",
    "robots.txt",
    "sitemap.xml",
    "activate/index.html"
  ].map(file => path.join(repoRoot, file));

  const blogFiles = walkTextFiles(path.join(repoRoot, "blog"));
  const filesToUpload = [...staticFiles, ...blogFiles];

  for (const localFile of filesToUpload) {
    const content = fs.readFileSync(localFile, "utf8");
    const remoteFile = toRemotePath(localFile);
    console.log(`Uploading ${path.relative(repoRoot, localFile)} -> ${remoteFile}`);
    await client.saveTextFile(remoteFile, content);
  }

  console.log(`Uploaded ${filesToUpload.length} text files to 1Panel.`);
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
