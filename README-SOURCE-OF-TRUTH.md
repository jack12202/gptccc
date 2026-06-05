# gptc.cc 主发布源说明

这个目录是 **gptc.cc 当前唯一主发布源**。

路径：

- `/Users/jack/Projects/aipass-blog-automation/_repos/gptccc`

## 你应该在这里改什么

- 首页 `index.html`
- 博客 `blog/`
- 充值页 `activate/index.html`
- `robots.txt`
- `sitemap.xml`

## 你不应该优先改哪里

不要优先改这个旧目录：

- `/Users/jack/Projects/网站/gptccc`

那个目录现在只能当：

- 历史参考
- 素材参考
- 旧版本参考

## 上线方式

这个仓库已经接了 GitHub 自动部署到 VPS。

流程：

1. 在这个目录修改
2. `git commit`
3. `git push origin main`
4. GitHub Actions 自动部署到 `gptc.cc`

## 当前自动部署覆盖范围

- `index.html`
- `blog/`
- `robots.txt`
- `sitemap.xml`
- `activate/index.html`

## 一句话提醒

**以后改 gptc.cc，先打开这个目录，不要先打开 `网站/gptccc`。**
