# GLM Balance 插件 · 开发与踩坑记录

> 2026-10-23 完成并验收。本文件是后来改这个插件（或做类似 DSH 插件）时的经验速查。
> 源码即本目录；安装方式：`plugin_manager install_bundle` + tarball（见下）。

## 功能现状（v1.2.2）

- **悬浮状态栏**：注入到输入框下方内置栏（`data-composer-dock`）的正下方，显示 GLM 套餐
  5h / 每周额度百分比+迷你进度条+重置时间、MCP 工具调用量、今日调用次数与 token；
  ↻ 点击立即刷新（绕过 60s 缓存），平时 5 分钟自动刷新。
- **glm_balance 工具**：会话里说「查一下 GLM 余额」即可，输出详细文本报告。
- 配色全部用 DSH 主题令牌（`--dsw-alias-*` + `color-mix`），自动跟随浅色/深色。

## 数据源（智谱 GLM Coding Plan 监控接口，非官方文档但公开）

```
GET https://open.bigmodel.cn/api/monitor/usage/quota/limit
    Authorization: <API Key 原文>            # 不加 Bearer
    → data.limits[]:
      TOKENS_LIMIT unit=3 number=5  → 5 小时窗口（percentage=已用%, nextResetTime=ms 时间戳）
      TOKENS_LIMIT unit=6 number=1  → 每周
      TIME_LIMIT    unit=5          → 工具/MCP 调用池（usage/currentValue/remaining + usageDetails[] 按 modelCode）
GET /api/monitor/usage/model-usage?startTime=YYYY-MM-DD HH:mm:ss&endTime=…
    → data.totalUsage.totalModelCallCount / totalTokensUsage（+按小时序列）
GET /api/monitor/usage/tool-usage?…        # 同参数格式
```

- **没有缓存命中率接口**（cache-usage 等均 404）。DSH 内置那栏的「缓存命中」来自
  DSH 自己 session 日志里的 usage（`cacheReadTokens`），只有 DeepSeek 系 provider 解析。
- Z.ai 账号把域名换成 `https://api.z.ai`（本插件 `baseURL` 配置可改）。

## 密钥

- 引用名 `ZAI_CODING_CN_API_KEY`，实际值在 `~/.dsh/.credentials.yaml` 的 `refs` 下。
- 插件内用 `ctx.credentials.resolve(ref)` → `{value, source} | undefined`，不要直读文件。

## DSH 插件机制踩坑（血泪，按代价排序）

1. **Host 模块有 ESM 缓存**：改了 `index.js` 必须完全退出并重启 DSH Desktop 才生效；
   `remove_bundle`+`install_bundle` 重装同一批文件**不会**让新模块加载（同 URL 命中缓存）。
2. **`apply()` 返回的清理函数不会被调用**：清理必须写进 `ctx.effect(() => { …; return cleanup })`。
   教训：禁用插件时旧路由没被回收，再启用就报
   `webserver: duplicate exact route "/api/…"`（这个报错反而是"路由已注册"的铁证）。
3. **路由注册要对 duplicate 容错**（catch 后复用），否则一次状态翻转会卡死在 failed。
4. **Desktop 的 webserver 对非 Electron 请求一律 403**（`openBrowser:false` 时）。
   终端里 curl 测 `/`、`/plugins/*`、自家路由全是 403——**403 ≠ 路由没注册**，
   别被它带偏（本次排查走的大弯路）。页面内 fetch 自带渲染令牌，不受影响。
   想临时用 curl 验证可改 profile `cordis.patch.yml` 的 `desktop-shell.openBrowser: true`，
   但 app 会把配置写回去（改了会被回滚），且当时还引发过一次启动崩溃，慎用。
5. **client 模块（`dsh.client` + `./client` 导出）在本桌面环境始终没进启动图**，原因未查明
   （与能否用符号链接安装疑似有关）。**可靠替代**：`ctx.webServer.tapIndex(html => …)` 把
   `<script>` 直接注入页面 HTML —— 桌面端自己的页面加载通道，必然执行。
   本插件最终方案就是 tapIndex + 纯 JS 悬浮条，放弃 client 模块。
6. **安装格式**：`install_bundle` 对目录用 `link:`（符号链接）；能正常显示的第三方插件都是
   `file:` 实体拷贝。稳妥做法：打包 tgz 再 `install_bundle file:/tmp/xxx.tgz`。
   注意 **pnpm 安装 tgz 会把 `locale/` 目录扁平化**（zh.json 落到包根），
   装完要手动 `mkdir locale && mv *.json locale/` 一次。
7. **读别人的正确姿势**：`@deepseek-ai/dsh-client-ui-conversation/lib/client.js` 等
   lib 产物是可读源码；slot/属性/事件都以 `cordis_inspect_query` 实测为准
   （注意：本会话的 inspect 工具传 `input` 参数会报 "input must be an object"，只能无参查询）。
8. **DOM 注入 etiquette**：不要往 React 管理的容器里塞节点（会被 reconcile 掉），
   用 `container.parentNode.insertBefore(mine, container.nextSibling)` 插**兄弟节点**，
   配 MutationObserver 在切换会话/容器重建后重新贴靠。内置输入框下方栏的定位标记：
   `[data-composer-dock]`。
9. **主题**：注入元素直接用 `var(--dsw-alias-bg-overlay / label-secondary / border-l1 / brand-primary)`
   + `color-mix(in srgb, var(…) 72%, transparent)` 做半透明，自动跟随浅/深色。
10. **内置指标栏是条件显示**：输入框下方的 `47 tok/s / 缓存命中 x% / 19%` 来自
    `dsh-client-ui-chat`（conversation.composer.dock 的 activity/usage 两个 pill）——
    tok/s 仅生成时出现，用量统计要有已完成的轮次才显示，别误判成"被插件挤掉了"。

## 数据快照示例（2026-10-23 验收时）

5h 已用 17%（重置当日 11:39）｜每周已用 78%（重置 10-26 08:30）｜MCP 127/4000
（search-prime 109、web-reader 18、zread 0）｜当日 389 次调用、45.5M tokens。

## 改动流程（以后要改就照这个来）

1. 改 `~/Documents/dsh-glm-balance/` 下源码；
2. `node --check index.js client.js`；
3. 打 tarball（不含目录条目）→ `remove_bundle` → `install_bundle file:/tmp/….tgz`；
4. 装完把 `locale/*.json` 归位（见第 6 条）；
5. **重启 DSH Desktop**；视觉验证右下状态栏 + 内置栏共存不遮挡。

## 发布与收尾记录（2026-10-26，项目已关闭）

- **开源仓库**：https://github.com/vcve/dsh-glm-balance（MIT）
- **Release**：v1.0.0，附安装 tgz（下载后 DSH 插件管理本地安装 + 重启）
- **市场收录**：已向精选列表提交 PR（awesome-dsh-plugin#9512，分类 `usage`），
  合并后即可在 dshmarket「发现」页搜到；流程 = fork 后加
  `data/plugins/<owner>__<repo>.yml` 一个文件（url/name/category/description 双语）。

### 隐私加固教训（公开发布必查清单）

1. **git 提交身份**：机器全局配置是真名+真实邮箱，公开仓库提交前必须
   `git config user.name/user.email` 覆盖为 GitHub 用户名 + `users.noreply.github.com`。
2. **改文件 ≠ 改历史**：修完敏感信息后若只是追加提交，旧提交仍可 `git log -p` 看到；
   要 `--orphan` 重做成单提交再 force push。
3. **Release 资产是独立副本**：历史重写后，之前上传的 tgz 里还是旧文件，必须删掉重传。
4. **全深度自查命令**：
   `git grep -in "<敏感词>" $(git rev-list --all)`（扫所有提交的所有文件）
   + `gh api repos/<owner>/<repo>/commits` 核对线上作者身份。
5. **README 预览图**：真机截图会带出会话标题、工作区名、真实用量；用 Pillow 按真实
   样式重绘"示意图"（占位数据）即可，注意系统 CJK 字体用 Hiragino Sans GB.ttc（SFNS
   不含中文），缺字形的符号（↻）用手绘弧线+三角代替。
6. **复用本机已有登录态**：`gh auth status` 发现已登录即可直接 `gh repo create/create PR`，
   无需向用户索要凭证。

### 复装/迁移速查

改代码 → `node --check` → 打 tgz（含 locale/ 子路径）→ `remove_bundle` +
`install_bundle file:…tgz` → 装完把 `*.json` 归位 `locale/` → 重启 DSH Desktop。
