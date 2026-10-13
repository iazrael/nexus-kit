# nexus-kit

个人 Web App 复用底座：PWA 运行时、构建插件、工程流程 CLI 与新项目模板。

| 包 | 作用 |
|---|---|
| `@nexus-kit/pwa` | PWA 控制器（检测链、弹窗时机、升级状态机、强制更新、`?nosw=1`）、版本比对、安装识别、离线补缓存 |
| `@nexus-kit/pwa-react` | `usePwaUpdate`、`useInstallPrompt` |
| `@nexus-kit/vite` | `nexusPwa()` 构建插件、`verifyPwaBuild()` 构建后门禁 |
| `@nexus-kit/devflow` | `nexus-devflow`：docs-audit、check-changelog、install-hooks、deploy |

```bash
pnpm install
pnpm check                      # 完成标准
pnpm e2e                        # 真浏览器升级链
pnpm init-app ../my-app --title 我的应用   # 从模板生成新项目
```

开发规则与文档索引见 [CLAUDE.md](CLAUDE.md)；为什么这样设计见 [docs/需求/需求.md](docs/需求/需求.md)。
