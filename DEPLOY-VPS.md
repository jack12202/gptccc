# gptc.cc 自动部署到 VPS

这个仓库已经配置了 GitHub Actions 自动部署，并且直接通过 `1Panel API` 把首页和博客同步到 VPS。

触发方式：
- `push` 到 `main`
- GitHub Actions 页面手动点 `Run workflow`

## 需要配置的 GitHub Secrets

在仓库 `Settings -> Secrets and variables -> Actions` 里新增：

- `PANEL_BASE`
  - 例：`http://72.11.133.145:37764`
- `PANEL_ENTRANCE`
  - 例：`jack`
- `PANEL_USER`
  - 例：`zjk`
- `PANEL_PASS`
  - 你的 1Panel 登录密码
- `PANEL_TARGET_DIR`
  - 例：`/opt/1panel/apps/openresty/openresty/www/sites/gptc.cc/index/gptccc-main`

## 部署范围

工作流会自动同步这些内容：

- `index.html`
- `robots.txt`
- `sitemap.xml`
- `blog/`

## 不会覆盖的内容

这套自动部署**不会删除或覆盖**服务器上单独维护的：

- `activate/`

这样你的博客和首页可以继续自动发布，但站内充值页仍然可以单独维护。
