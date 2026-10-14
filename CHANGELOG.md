# 更新日志

源码改动必须附条目（precommit 门禁）。发布时整合 Unreleased 落款为 `## [版本号] - 日期`。
破坏接入方的改动记「破坏性：」开头并写迁移方法；不影响接入方的记「内部：」开头。

## [Unreleased]

## [0.5.0] - 2026-10-14

- 新增：`@nexus-kit/runtime/perf` 性能采集。`createPerf` 每 5 秒采一个水位点（帧率、卡顿、最差一帧、JS 堆、DOM 节点、存储用量、长任务，加宿主经 `registerGauge` 登记的指标；读不到记 null），环形长线约 2.8 小时，`trend()` 给出首尾、净增与峰值；每个会话最后 120 个点跨会话保留（多窗口各写各的行），上一局闪退前的水位下一局能导出；`captureBoot` 采启动画像（导航分段、按类型的网络字节与缓存命中、最慢资源、是否 SW 接管），留最近 5 次；`milestone` / `span` / `spanAsync` 记时间点与阶段耗时；帧统计支持 rAF 自测与宿主每帧 `frameStart/frameEnd`；可选 `installGlCounter` 记 GL 对象净存活数与纹理字节。数据进诊断文件：启动画像、性能走势、其他会话最后的水位三节，及「性能数据（JSONL）」附录。
- 新增：`/log` 的 `registerAppendix` 与 `exportText({ appendix })`：附录排在日志之后，复制到聊天可不带。
- 新增：模板接入性能采集：`observe.ts` 创建并启动，挂载时（`onAppMounted`）与 load 后各采一次启动画像；复制诊断内容不带 JSONL 附录。
- 内部：诊断 e2e 断言启动画像、性能走势、JSONL 各类行与被杀那一局的水位。

## [0.4.0] - 2026-10-14

- 新增：`@nexus-kit/runtime` 包。`/log`：命名日志、级别阈值（`?log=debug` 只对本会话生效）、按模块分区的环形缓冲、跨会话保留（按会话轮转、有总量上限）、行式文本导出，写盘失败计入导出头部。`/lifecycle`：上一局退出判词（首次 / 正常 / 疑似异常 / 无法判定，多窗口各记各的，Web Locks 区分「还开着」与「刚闪退」）、未捕获异常进日志（限频）、诊断文件交付（系统分享优先、下载兜底，导出时去掉 URL 查询串）、离开前限时保存。
- 新增：`/lifecycle` 诊断面板（发送诊断文件 / 复制诊断内容，原生 DOM，不依赖应用框架与样式）与白屏兜底（挂载前异常或渲染崩溃时整页显示诊断面板）；触屏设备优先系统分享，桌面直接下载。
- 新增：`/boot`（`reloadLatest`、`bootGuardScript`、`markBooted`）与 `/lifecycle` 的 `reloadToLatestVersion`：兜底页「重新加载」先激活已下载好的新版本再刷新（升级确认原则的唯一例外），没有新版本时检查完立即刷新；主包加载失败的内联兜底与它同一份源码、只用 ES5。整页诊断面板的「重新加载」默认走这条路。`/log` 的 `truncateExport`：复制到聊天时截短（头部完整、日志取最近的行、补会话分隔、省略说明由宿主给）。
- 新增：模板经 vite 注入主包加载失败兜底——主包没加载上时显示「加载失败 + 重新加载」，不再一片白；主包晚到时自动撤下。
- 新增：模板接入日志、取证、异常捕获与白屏兜底（根错误边界），pwa 控制器的日志写进同一份记录；版本号 2 秒内连点 5 次打开诊断面板，第 3 下起提示还差几下。
- 变更：`worktree.postMerge` 默认改为先 `pnpm install --frozen-lockfile` 再 `pnpm build`——工作树里加了依赖时，合入后主仓库的验证不再因找不到新依赖而失败；没写 `postMerge` 的宿主升级后自动生效，不用改；自定义了 `postMerge` 的宿主请把 `["pnpm", "install", "--frozen-lockfile"]` 加为数组的第一项。
- 内部：工作树提示统一为 `pnpm worktree:*`；e2e 产物改放 `.e2e/` 并登记为可再生，回收工作树不再被拦。
- 内部：`pnpm e2e` 增加日志与诊断一条（刷新保留、CDP 杀进程后判疑似异常、导出内容）；init-app 改为从 `packages/` 读取 kit 包清单。

## [0.3.0] - 2026-10-14

- 新增：`nexus-devflow worktree new|merge|rm|ls|isolate|hook-create|hook-remove` —— 并行开发工作树：共享项软链回主仓库、预览端口登记、合入只快进（分叉拒绝、并发合入拒绝、被钩子拦下自动还原残留、合入后在主仓库验证）、回收先停服务再删目录并拦截不可再生文件；接 Claude Code 的 WorktreeCreate/WorktreeRemove 钩子。配置在 `nexus.config.json` 的 `worktree` 段。
- 新增：`nexus-devflow release [--ack|--lock|--unlock]` —— 发版一条命令（落款校验 → 放锁 → 检查/构建/部署 → 打 tag 推送 → 可选 GitHub Release → 收锁）；`install-hooks` 额外写入 reference-transaction 发版锁钩子，发版期间冻结主干、凭 `NEXUS_RELEASE_TOKEN` 放行。已接入的项目升级后执行一次 `pnpm hooks` 才会装上新钩子。
- 新增：模板接入 `worktree:*` / `release*` 脚本与 `.claude/settings.json` 钩子，交付规范 §5 发布、§6 并行开发改为以这两组命令为准。

## [0.2.0] - 2026-10-13

- 破坏性：「稍后」改为有效期制——同一构建在本次打开期间不再自动提醒，最长 24 小时后心跳或切前台命中会再提醒（`dismissTtlMs` 可配）。此前同一构建在整个会话内永不再提醒；接入方无需改代码。
- 变更：模板升级弹窗不再内置「强制更新」按钮，入口由项目自行挂载（`usePwaUpdate().forceUpgrade` 不变）。

## [0.1.0] - 2026-10-13

- 新增：`@nexus-kit/pwa` —— PWA 控制器（检测链、弹窗时机、升级状态机、强制更新、`?nosw=1`）、版本比对、安装环境识别、离线补缓存、持久化存储申请。
- 新增：`@nexus-kit/pwa-react` —— `usePwaUpdate`（快照订阅 + 带重入闸的确认升级）、`useInstallPrompt`。
- 新增：`@nexus-kit/vite` —— `nexusPwa()` 构建插件（版本注入、version.json、VitePWA 红线配置、运行时缓存分区与旧仓清理）与 `verifyPwaBuild()` 构建后门禁。
- 新增：`@nexus-kit/devflow` —— `nexus-devflow` 命令：活文档审计、CHANGELOG 提交门禁、git hooks、部署到自有服务器（冒烟 + 自动回滚）与 nginx 样板。
- 内部：升级确认重入闸加会话号，取消后的旧保存迟到结算不再放开新一轮的闸（复审发现的竞态）；dist 新鲜度门禁按暂存区判定。
- 新增：`templates/webapp` 新项目模板与 `pnpm init-app`；模板自带通用开发规范与活文档体系；`pnpm e2e` 真浏览器升级链验证。
