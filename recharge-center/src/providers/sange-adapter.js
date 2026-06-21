import { config } from "../config.js";
import { requestJson } from "./http-json.js";

function buildHeaders() {
  const headers = {
    "Content-Type": "application/json"
  };

  if (config.upstreamAuthToken) {
    const prefix = config.upstreamAuthScheme ? `${config.upstreamAuthScheme} ` : "";
    headers[config.upstreamAuthHeader] = `${prefix}${config.upstreamAuthToken}`;
  }

  return headers;
}

function bodyOf(raw) {
  return raw?.data?.data && typeof raw.data.data === "object" ? raw.data.data : raw?.data || {};
}

function normalizeVerify(raw) {
  const body = bodyOf(raw);
  const success = body.success === true;

  return {
    success,
    provider: "sange",
    providerLabel: "三哥",
    productId: Number(body.productId || config.defaultProductId),
    message: body.message || raw.data?.message || "",
    raw: body
  };
}

function normalizeStart(raw) {
  const body = bodyOf(raw);
  const taskId = body.taskId || body.task_id || "";
  const success = raw.ok && raw.data?.success !== false && body.success !== false && Boolean(taskId);

  return {
    success,
    provider: "sange",
    providerLabel: "三哥",
    taskId,
    status: success ? "processing" : "failed",
    message: body.message || raw.data?.message || "",
    raw: body
  };
}

function normalizeStatus(raw) {
  const body = bodyOf(raw);
  const upstreamStatus = body.status || (body.processing ? "processing" : "");
  const status =
    upstreamStatus === "success" || upstreamStatus === "completed"
      ? "success"
      : upstreamStatus === "failed"
        ? "failed"
        : "processing";

  return {
    success: raw.ok,
    provider: "sange",
    providerLabel: "三哥",
    status,
    message: body.message || raw.data?.message || upstreamStatus || "",
    raw: body
  };
}

function normalizeStartPayload(payload) {
  const fullAuthData = typeof payload.fullAuthData === "string"
    ? payload.fullAuthData
    : JSON.stringify(payload.fullAuthData || {});

  return {
    cardInfo: payload.cardInfo,
    userEmail: payload.userEmail || "",
    userGptToken: payload.userGptToken || "",
    fullAuthData,
    productId: payload.productId || config.defaultProductId,
    forceRecharge: Boolean(payload.forceRecharge ?? payload.overwriteRecharge)
  };
}

async function postJson(endpoint, payload) {
  return requestJson(config.upstreamBaseUrl, endpoint, {
    method: "POST",
    headers: buildHeaders(),
    payload
  });
}

export const sangeAdapter = {
  key: "sange",
  label: "三哥",

  async verifyCard({ cardInfo }) {
    const raw = await postJson("/api/cards/verify", { cardInfo });
    const data = normalizeVerify(raw);
    return {
      ok: raw.ok && data.success,
      status: raw.status,
      data
    };
  },

  async startRecharge(payload) {
    const raw = await postJson("/api/cards/verify-gpt", normalizeStartPayload(payload));
    const data = normalizeStart(raw);
    return {
      ok: data.success,
      status: raw.status,
      data
    };
  },

  async queryTaskStatus(payload) {
    const raw = await postJson("/api/recharge/query-task-status", payload);
    const data = normalizeStatus(raw);
    return {
      ok: raw.ok,
      status: raw.status,
      data
    };
  }
};
