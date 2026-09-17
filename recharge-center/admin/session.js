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
    const bar = document.createElement("nav");
    bar.setAttribute("aria-label", "登录管理");
    bar.style.cssText = "display:flex;align-items:center;justify-content:flex-end;flex-wrap:wrap;gap:10px;max-width:1320px;margin:0 auto 16px;font:14px system-ui;color:#475569";
    const label = document.createElement("span");
    label.textContent = "已登录";
    bar.append(label);
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
      bar.append(button);
    }
    document.body.prepend(bar);
  });
  // Revalidate pages restored from the back-forward cache after logout elsewhere.
  window.addEventListener("pageshow", event => { if (event.persisted) location.reload(); });
})();
