(function () {
  if (window.__jiageConversionTrackingLoaded) return;
  window.__jiageConversionTrackingLoaded = true;

  function clean(value, maxLength) {
    return String(value || "").replace(/\s+/g, " ").trim().slice(0, maxLength || 100);
  }

  function classify(element, url) {
    const signal = [
      element.getAttribute("href"),
      element.getAttribute("data-track"),
      element.getAttribute("data-track-event"),
      element.textContent,
      url.hostname,
      url.pathname,
    ].join(" ").toLowerCase();

    if (signal.includes("fe.dtyuedan.cn") || signal.includes("购买") || signal.includes("buy")) return "purchase_click";
    if (signal.includes("/activate") || signal.includes("recharge-go") || signal.includes("激活") || signal.includes("兑换")) return "activate_click";
    if (signal.includes("pro") || signal.includes("5x") || signal.includes("20x")) return "pro_consult_click";
    if (element.hasAttribute("data-copy-wx") || signal.includes("微信") || signal.includes("咨询")) return "wechat_consult_click";
    return "";
  }

  document.addEventListener("click", function (event) {
    const element = event.target.closest("a, button, [role='button'], [data-copy-wx]");
    if (!element) return;

    let url;
    try {
      url = new URL(element.getAttribute("href") || window.location.href, window.location.href);
    } catch (error) {
      return;
    }

    const eventName = classify(element, url);
    if (!eventName) return;

    window._hmt = window._hmt || [];
    window._hmt.push([
      "_trackEvent",
      "conversion",
      eventName,
      clean(`${window.location.pathname}|${element.textContent}`, 160),
    ]);
  }, true);
})();
