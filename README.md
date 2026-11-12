# nexus-kit

个人 Web App 复用底座：PWA 运行时、构建插件、工程流程 CLI 与新项目模板。

| 包 | 作用 |
|---|---|
| `@nexus-kit/pwa` | PWA 控制器（检测链、弹窗时机、升级状态机、强制更新、`?nosw=1`）、版本比对、安装识别、离线补缓存 |
| `@nexus-kit/pwa-react` | `usePwaUpdate`、`useInstallPrompt` |
| `@nexus-kit/runtime` | `/log` 日志、`/perf` 性能采集（水位长线、启动画像、帧统计）、`/assets` 图像资源（加载调度、关键闸门、解码位图缓存）、`/audio` 音频（解锁、回前台恢复与假死重建、音效与音乐播放）、`/lifecycle` 异常退出取证、诊断导出与白屏兜底、`/boot` 主包加载失败兜底 |
| `@nexus-kit/vite` | `nexusPwa()` 构建插件、`verifyPwaBuild()` 构建后门禁 |
| `@nexus-kit/devflow` | `nexus-devflow`：docs-audit、check-changelog、install-hooks、deploy、worktree、release、task（均支持 `--help`） |

```bash
pnpm install
pnpm check                      # 完成标准
pnpm e2e                        # 真浏览器：升级链、日志诊断、图像资源、音频
pnpm init-app ../my-app --title 我的应用   # 从模板生成新项目
```

开发规则与文档索引见 [CLAUDE.md](CLAUDE.md)；为什么这样设计见 [docs/需求/需求.md](docs/需求/需求.md)。

多 Agent 协作通过 `nexus-devflow task` 提供任务生成、派发、原会话续跑、返工、独立复跑和审查后验收。宿主在 nexus.config.json 显式配置 task 段；配置示例位于包内 templates/task.config.example.json，通用规则起点位于 templates/任务协作规则.md，拷贝后由宿主维护。普通 worktree 配置不受任务隔离配置影响，生成 Web App 不默认启动任务。机制与使用边界见[任务协作](docs/架构算法/任务协作.md)和[接入规范](docs/规范/接入规范.md)。

## License

[MIT](LICENSE)
