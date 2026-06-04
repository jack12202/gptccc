import { config } from "./config.js";
import { JsonStore } from "./store.js";
import { upstreamClient } from "./upstream-client.js";
import { encodeJson, maskCard, requiredString, safeJsonParse, sha256 } from "./utils.js";

const store = new JsonStore();

function parseSecretPayload(secretJsonText) {
  const parsed = safeJsonParse(secretJsonText);
  if (!parsed.ok || typeof parsed.value !== "object" || !parsed.value) {
    return { ok: false, message: "充值密钥不是合法 JSON。" };
  }

  const payload = parsed.value;
  const user = typeof payload.user === "object" && payload.user ? payload.user : {};
  const userEmail = requiredString(payload.userEmail)
    ? payload.userEmail.trim()
    : requiredString(user.email)
      ? user.email.trim()
      : "";
  const userGptToken = requiredString(payload.userGptToken)
    ? payload.userGptToken.trim()
    : requiredString(payload.accessToken)
      ? payload.accessToken.trim()
      : "";
  const fullAuthData =
    typeof payload.fullAuthData === "object" && payload.fullAuthData !== null
      ? payload.fullAuthData
      : payload;

  if (!requiredString(userEmail)) {
    return { ok: false, message: "充值密钥缺少 userEmail。" };
  }
  if (!requiredString(userGptToken)) {
    return { ok: false, message: "充值密钥缺少 userGptToken。" };
  }
  if (typeof fullAuthData !== "object" || fullAuthData === null) {
    return { ok: false, message: "充值密钥缺少 fullAuthData。" };
  }

  return {
    ok: true,
    data: {
      ...payload,
      userEmail,
      userGptToken,
      fullAuthData
    }
  };
}

export const rechargeService = {
  async verifyCard(cardInfo) {
    if (!requiredString(cardInfo)) {
      return { ok: false, status: 400, message: "请先输入卡密。" };
    }

    const upstream = await upstreamClient.verifyCard(cardInfo.trim());
    return {
      ok: upstream.ok,
      status: upstream.ok ? 200 : 502,
      upstream
    };
  },

  parseSecret(secretJsonText) {
    const result = parseSecretPayload(secretJsonText);
    if (!result.ok) {
      return { ok: false, status: 400, message: result.message };
    }

    const secret = result.data;
    const user = typeof secret.user === "object" && secret.user ? secret.user : {};
    const account = typeof secret.account === "object" && secret.account ? secret.account : {};

    return {
      ok: true,
      status: 200,
      data: {
        userEmail: secret.userEmail,
        hasToken: true,
        hasFullAuthData: true,
        userName: typeof user.name === "string" ? user.name : "",
        userId: typeof user.id === "string" ? user.id : "",
        accountId: typeof account.id === "string" ? account.id : "",
        accountPlanType: typeof account.planType === "string" ? account.planType : "",
        accountStructure: typeof account.structure === "string" ? account.structure : "",
        authProvider: typeof secret.authProvider === "string" ? secret.authProvider : "",
        expires: typeof secret.expires === "string" ? secret.expires : ""
      },
      parsedSecret: secret
    };
  },

  async confirmRecharge(input) {
    const { cardInfo, secretJsonText, productId, overwriteRecharge, siteSource } = input;

    if (!requiredString(cardInfo)) {
      return { ok: false, status: 400, message: "缺少卡密。" };
    }

    const parsed = this.parseSecret(secretJsonText);
    if (!parsed.ok) return parsed;

    const secret = parsed.parsedSecret;
    const cardMask = maskCard(cardInfo.trim());
    const order = store.createOrder({
      siteSource,
      cardMask,
      productId: Number(productId || config.defaultProductId),
      overwriteRecharge,
      status: "processing",
      message: "任务已创建，等待上游处理。"
    });

    store.createRechargeSession({
      orderId: order.id,
      userEmail: secret.userEmail,
      tokenHash: sha256(secret.userGptToken),
      authDataEncoded: encodeJson(secret.fullAuthData)
    });

    const upstreamPayload = {
      cardInfo: cardInfo.trim(),
      userEmail: secret.userEmail,
      userGptToken: secret.userGptToken,
      fullAuthData: secret.fullAuthData,
      productId: Number(productId || config.defaultProductId)
    };

    store.addLog({
      orderId: order.id,
      step: "verify-gpt.request",
      requestSummary: JSON.stringify({
        cardMask,
        userEmail: secret.userEmail,
        productId: upstreamPayload.productId,
        overwriteRecharge: Boolean(overwriteRecharge)
      }),
      responseSummary: "pending"
    });

    const upstream = await upstreamClient.startRecharge(upstreamPayload);
    const upstreamTaskId = upstream.data?.data?.taskId || "";
    const message = upstream.data?.data?.message || upstream.data?.message || "已提交上游任务。";
    const status = upstream.ok ? "processing" : "failed";

    store.updateOrder(order.id, {
      upstreamTaskId,
      status,
      message
    });

    store.addLog({
      orderId: order.id,
      step: "verify-gpt.response",
      requestSummary: "completed",
      responseSummary: JSON.stringify({
        ok: upstream.ok,
        status: upstream.status,
        upstreamTaskId,
        message
      })
    });

    return {
      ok: upstream.ok,
      status: upstream.ok ? 200 : 502,
      data: {
        orderId: order.id,
        taskId: upstreamTaskId,
        status,
        message
      }
    };
  },

  async getStatus(orderId) {
    const order = store.getOrder(orderId);
    if (!order) {
      return { ok: false, status: 404, message: "订单不存在。" };
    }

    if (!order.upstreamTaskId || !["processing", "created"].includes(order.status)) {
      return {
        ok: true,
        status: 200,
        data: {
          orderId: order.id,
          status: order.status,
          message: order.message
        }
      };
    }

    const upstream = await upstreamClient.queryTaskStatus({
      taskId: order.upstreamTaskId,
      productId: order.productId
    });

    const upstreamStatus = upstream.data?.data?.status || "processing";
    const message = upstream.data?.data?.message || order.message || "";
    const nextStatus = upstreamStatus === "success" ? "success" : upstreamStatus === "failed" ? "failed" : "processing";

    store.updateOrder(order.id, {
      status: nextStatus,
      message
    });

    store.addLog({
      orderId: order.id,
      step: "query-task-status",
      requestSummary: JSON.stringify({
        taskId: order.upstreamTaskId,
        productId: order.productId
      }),
      responseSummary: JSON.stringify({
        ok: upstream.ok,
        status: upstream.status,
        upstreamStatus,
        message
      })
    });

    return {
      ok: true,
      status: 200,
      data: {
        orderId: order.id,
        taskId: order.upstreamTaskId,
        status: nextStatus,
        message
      }
    };
  }
};
