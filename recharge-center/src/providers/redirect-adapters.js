function makeRedirectAdapter({ key, label, redirectUrl }) {
  function redirectResult() {
    return {
      ok: false,
      status: 409,
      data: {
        success: false,
        provider: key,
        providerLabel: label,
        providerMode: "redirect",
        redirectUrl,
        message: `当前已切换到${label}备用通道，正在打开对应页面。`
      }
    };
  }

  return {
    key,
    label,
    mode: "redirect",
    redirectUrl,
    verifyCard: redirectResult,
    startRecharge: redirectResult,
    queryTaskStatus: redirectResult
  };
}

export const dnsconAdapter = makeRedirectAdapter({
  key: "dnscon",
  label: "白",
  redirectUrl: "https://dnscon.xyz/"
});

export const ai9977Adapter = makeRedirectAdapter({
  key: "9977ai",
  label: "七七",
  redirectUrl: "https://9977ai.vip/"
});
