import { config } from "./config.js";

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

async function postJson(endpoint, payload) {
  const response = await fetch(new URL(endpoint, config.upstreamBaseUrl), {
    method: "POST",
    headers: buildHeaders(),
    body: JSON.stringify(payload)
  });
  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  return {
    ok: response.ok,
    status: response.status,
    data
  };
}

export const upstreamClient = {
  verifyCard(cardInfo) {
    return postJson("/api/cards/verify", { cardInfo });
  },
  startRecharge(payload) {
    return postJson("/api/cards/verify-gpt", payload);
  },
  queryTaskStatus(payload) {
    return postJson("/api/recharge/query-task-status", payload);
  }
};
