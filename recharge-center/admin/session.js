(() => {
  try { localStorage.removeItem("gptcProviderAdminToken"); } catch {}
  const clean = new URL(location.href);
  clean.searchParams.delete("token");
  clean.searchParams.delete("adminToken");
  clean.hash = "";
  history.replaceState(null, "", clean.pathname + clean.search);
  let sessionPromise;
  let redirecting = false;
  const login = () => {
    if (redirecting) return;
    redirecting = true;
    location.replace("/admin/login?next=" + encodeURIComponent(location.pathname));
  };
  async function request(url, options = {}) {
    const response = await fetch(url, { ...options, credentials: "same-origin", cache: "no-store" });
    if (response.status === 401) {
      login();
      throw new Error("登录已过期，正在前往登录页。");
    }
    const data = await response.json();
    if (!response.ok || !data.success) throw new Error(data.message || "操作失败，请稍后重试。");
    return data.data;
  }
  window.adminApi = async (url, options = {}) => {
    sessionPromise ||= request("/api/admin/session").catch(error => { sessionPromise = null; throw error; });
    const session = await sessionPromise;
    return request(url, { ...options, headers: { "Content-Type": "application/json", ...options.headers, "X-CSRF-Token": session.csrf } });
  };
  document.addEventListener("DOMContentLoaded", () => {
    const path = location.pathname.replace(/\/$/, "") || "/admin";
    const section = path === "/admin" ? "工作台"
      : ["/admin/recoveries", "/admin/pro-orders"].includes(path) ? "充值订单"
      : path.startsWith("/admin/cards") ? "卡密管理"
      : ["/admin/hifupay/cards", "/admin/zzshu"].includes(path) ? "支付卡池"
      : "协议设置";
    const bar = document.createElement("header");
    bar.setAttribute("aria-label", "GPTC 后台导航");
    bar.style.cssText = "position:fixed;z-index:1000;top:0;left:0;right:0;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;padding:10px max(16px,calc((100vw - 1320px)/2));background:#ffffffee;border-bottom:1px solid #dbe4ee;box-shadow:0 4px 18px #0f172a0d;font:14px system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#475569;backdrop-filter:blur(8px)";
    const links = [["工作台", "/admin"], ["卡密管理", "/admin/cards"], ["充值订单", "/admin/recoveries"], ["支付卡池", "/admin/hifupay/cards"], ["协议设置", "/admin#protocol-settings"]];
    const nav = document.createElement("nav");
    nav.setAttribute("aria-label", "后台一级导航");
    nav.style.cssText = "display:flex;align-items:center;flex-wrap:wrap;gap:6px";
    const brand = document.createElement("a");
    brand.href = "/admin";
    brand.textContent = "GPTC 后台";
    brand.style.cssText = "margin-right:6px;color:#0f172a;font-weight:900;text-decoration:none";
    nav.append(brand);
    for (const [text, href] of links) {
      const link = document.createElement("a");
      link.href = href;
      link.textContent = text;
      if (text === section) link.setAttribute("aria-current", "page");
      link.style.cssText = "padding:7px 10px;border-radius:8px;text-decoration:none;font-weight:800;color:" + (text === section ? "#fff;background:#0f766e" : "#475569;background:transparent");
      nav.append(link);
    }
    const controls = document.createElement("nav");
    controls.setAttribute("aria-label", "登录管理");
    controls.style.cssText = "display:flex;align-items:center;justify-content:flex-end;flex-wrap:wrap;gap:8px";
    const label = document.createElement("span");
    label.textContent = "已登录";
    controls.append(label);
    for (const [text, endpoint] of [["退出登录", "logout"], ["退出所有设备", "logout-all"]]) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = text;
      button.style.cssText = "width:auto;min-height:36px;padding:6px 12px;border:1px solid #cbd5e1;border-radius:8px;background:white;color:#334155;cursor:pointer";
      button.onclick = async () => {
        if (endpoint === "logout-all" && !confirm("退出所有设备后，每台设备都需要重新登录。确认退出？")) return;
        button.disabled = true;
        try { await window.adminApi("/api/admin/" + endpoint, { method: "POST", body: "{}" }); location.replace("/admin/login"); }
        catch (error) { label.textContent = error.message; button.disabled = false; }
      };
      controls.append(button);
    }
    bar.append(nav, controls);
    document.body.prepend(bar);
    document.body.style.paddingTop = "112px";
  });
  // Revalidate pages restored from the back-forward cache after logout elsewhere.
  window.addEventListener("pageshow", event => { if (event.persisted) location.reload(); });
})();
