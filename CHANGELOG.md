# 更新日志

源码改动必须附条目（precommit 门禁）。发布时整合 Unreleased 落款为 `## [版本号] - 日期`。
破坏接入方的改动记「破坏性：」开头并写迁移方法；不影响接入方的记「内部：」开头。

## [Unreleased]

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
