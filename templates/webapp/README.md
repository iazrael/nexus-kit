# Nexus App

由 [nexus-kit](https://github.com/iazrael/nexus-kit) 模板生成的 Web App（Vite + React + Tailwind + PWA）。

```bash
pnpm install && pnpm hooks   # 安装依赖，启用 CHANGELOG 提交门禁与发版锁钩子
pnpm dev                     # 开发
pnpm check                   # 完成标准：文档审计、lint、类型、单测、构建与构建后门禁
pnpm worktree:new feat/x     # 开并行工作树（合回：pnpm worktree:merge feat/x；回收：pnpm worktree:rm x）
pnpm release --ack           # 发版：检查 → 构建 → 部署 → 打 tag 推送（先填 nexus.config.json 的 deploy 段）
```

开发规则与文档索引见 [CLAUDE.md](CLAUDE.md)。
