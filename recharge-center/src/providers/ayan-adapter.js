import { config } from "../config.js";
import { extractCardCode } from "../utils.js";
import { requestJson } from "./http-json.js";

function extractTaskIdFromError(errorText = "") {
  const match = String(errorText).match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  return match ? match[0] : "";
}

function sanitizeVerifyRaw(body, available, message) {
  if (!available) {
    return {
      available: false,
      error: message
    };
  }

  const rawWithoutAccount = { ...body };
  delete rawWithoutAccount.used_email;
  return rawWithoutAccount;
}

function normalizeVerify(raw, cardCode) {
  const body = raw.data || {};
  const productApiType = body.product_api_type || "gpt";
  const available = body.available === true;
  const unsupportedClaude = productApiType === "claude";
  const used = body.available === false && body.error === "卡密已被使用";
  const message = unsupportedClaude ? "当前页面暂不支持 Claude 卡密，请使用 GPT 卡密。" : used ? "卡密已被使用" : body.error || "";

  return {
    success: available && !unsupportedClaude,
    provider: "ayan",
    providerLabel: "阿妍",
    cardCode,
    productId: config.defaultProductId,
    productApiType: available || unsupportedClaude ? productApiType : "",
    stockLevel: available ? body.stock_level || "" : "",
    usedEmail: "",
    message,
    raw: sanitizeVerifyRaw(body, available, message)
  };
}

function normalizeStart(raw) {
  const body = raw.data || {};
  const taskId = body.task_id || extractTaskIdFromError(body.error);
  const alreadyProcessing = raw.status === 409 && Boolean(taskId);
  const success = body.success === true || alreadyProcessing;

  return {
    success,
    provider: "ayan",
    providerLabel: "阿妍",
    taskId,
    status: success ? "processing" : "failed",
    message: body.message || body.error || (alreadyProcessing ? "已有任务正在处理中。" : ""),
    raw: body
  };
}

function normalizeStatus(raw) {
  const body = raw.data || {};
  const upstreamStatus = body.status || "unknown";
  const status =
    upstreamStatus === "completed"
      ? "success"
      : upstreamStatus === "failed" || upstreamStatus === "cancelled" || upstreamStatus === "unknown"
        ? "failed"
        : "processing";

  const queueMessage =
    upstreamStatus === "pending" && Number(body.queue_position) > 0
      ? `排队等待中，前面还有 ${body.queue_position} 个任务。`
      : "";

  return {
    success: raw.ok,
    provider: "ayan",
    providerLabel: "阿妍",
    status,
    upstreamStatus,
    message: body.result || body.error || queueMessage || upstreamStatus,
    queuePosition: body.queue_position || 0,
    raw: body
  };
}

export const ayanAdapter = {
  key: "ayan",
  label: "阿妍",

  async verifyCard({ cardInfo }) {
    const cardCode = extractCardCode(cardInfo);
    const raw = await requestJson(config.ayanBaseUrl, `/api/card-keys/${encodeURIComponent(cardCode)}`);
    const data = normalizeVerify(raw, cardCode);
    return {
      ok: raw.ok && data.success,
      status: raw.status,
      data
    };
  },

  async startRecharge({ cardInfo, userGptToken, authProvider, overwriteRecharge }) {
    const cardCode = extractCardCode(cardInfo);
    const raw = await requestJson(config.ayanBaseUrl, "/api/tasks", {
      method: "POST",
      payload: {
        card_key: cardCode,
        access_token: userGptToken,
        idp: authProvider || "",
        force_recharge: Boolean(overwriteRecharge)
      }
    });
    const data = normalizeStart(raw);
    return {
      ok: data.success,
      status: raw.status,
      data
    };
  },

  async queryTaskStatus({ taskId }) {
    const raw = await requestJson(config.ayanBaseUrl, `/api/tasks/${encodeURIComponent(taskId)}`);
    const data = normalizeStatus(raw);
    return {
      ok: raw.ok,
      status: raw.status,
      data
    };
  }
};
