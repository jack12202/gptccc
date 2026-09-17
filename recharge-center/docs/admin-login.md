# 后台统一登录

入口：`https://www.gptc.cc/admin/login`。沿用服务器 `ADMIN_TOKEN`，不变更嗨付凭据。

- 所有后台页面共用会话；未经登录重定向至登录页，管理 API 返回 401。
- 默认会话最长 8 小时；选择“记住此设备 7 天”后 Cookie 保留 7 天。临时会话仍由服务端限制 8 小时，浏览器会话恢复功能不会延长这个期限。
- Cookie 使用 `__Host-` 前缀、Secure、HttpOnly、SameSite=Strict。写请求同时校验 `PUBLIC_BASE_URL` 的 Origin 和随机 CSRF token。线上须通过 HTTPS 访问规范域名。
- 登录失败限制为每来源地址 15 分钟内 5 次，全服务 100 次；仅信任 loopback 反代提供的 X-Real-IP，否则按连接地址计数。容器反代可能共用一个限额；如需区分，必须先显式配置可信代理，不可直接信任任意请求头。
- 退出登录撤销当前会话；退出所有设备撤销全部会话。更换 ADMIN_TOKEN 并重启也会使已有会话失效。
- 登录页和后台脚本会清理旧的 `gptcProviderAdminToken` 本地存储。旧 URL、请求体和 X-Admin-Token 不再作为管理鉴权；外部维护脚本需使用登录会话及 CSRF token。
- 旧 `/admin/provider/switch` GET 链接仅跳转至切换页，不再修改通道。

会话摘要及 CSRF token 存在 DATA_FILE 同目录的 `admin-sessions.json`，权限 0600，临时文件替换方式保存。此文件不存管理密码或嗨付 Key；仍应按私有数据保护，不可放到静态站点目录或提交 Git。当前实现用于单后端进程；多进程部署前应迁移到共享事务会话库。登录限速状态保存在内存，重启会清除计数。

部署需同时发布 src/admin-auth.js、src/server.js、src/utils.js、admin/ 下页面和脚本，并为 `/admin/login` 与 `/admin/session.js` 配置反代。现有部署脚本已包括这两个入口。部署后执行 `scripts/verify-admin-session.mjs`；它只创建并撤销自己的测试登录，不读取业务数据或发起充值。

验证：`node --test recharge-center/test/*.test.js`。本机预览须使用隔离 DATA_FILE、虚构 ADMIN_TOKEN，以及匹配预览域名端口的 PUBLIC_BASE_URL。不得使用真实订单进行功能测试。
