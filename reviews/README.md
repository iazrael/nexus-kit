# 评审与图示

长期维护的生成类产物：评审报告、架构图等自包含 HTML。与 `docs/` 下的手写文档不同，
这里的 HTML 由 spec 渲染而来，**改内容要改 spec 再重画，不手改 HTML**。

基准：nexus-kit 0.7.0 / 2026-10-16（最后一次与 `docs/架构算法/总览.md` 核对）

## 现有产物

| 产物 | spec（权威输入） | 事实出处 |
| --- | --- | --- |
| [架构总览图](架构总览图.html) —— 包与边界、宿主接线、分发与版本 | [架构总览图.spec.json](架构总览图.spec.json) | [docs/架构算法/总览.md](../docs/架构算法/总览.md) |

## 命名与入库

- 活文档单文件，文件名只写主题，不带日期、版本、过程后缀（如 `架构总览图.html`）。
- 产物与它的 spec 同 basename、同目录；spec 一并入库，否则无法维护。
- `*.visual-check.*`（浏览器证据截图与回执）是可再生的临时 sidecar，不入库，已在根 `.gitignore` 排除。

## 维护流程

改 `docs/架构算法/总览.md` 里的包结构、依赖关系或分发方式时，同提交重画这张图：

1. 改 `架构总览图.spec.json`（节点、连线、文案、viewBox 都在里面）。
2. 校验：`node ~/.agents/skills/archify/bin/archify.mjs validate architecture reviews/架构总览图.spec.json --quality showcase --json`
   通过标准：9/9 artifact 检查、0 error、0 warning。
3. 交付：把上一条的 `validate` 换成 `deliver`，其余参数不变，末尾加输出路径 `reviews/架构总览图.html`。
4. 浏览器证据：`node ~/.agents/skills/archify/bin/archify.mjs visual-check reviews/架构总览图.html --json`
   通过标准：`status: pass`，1440×900 / 1600×1000 / 1920×1080 / 2048×1320 均无溢出。

重画后更新本文件顶部的基准行。

## 版式约定（改图前先看）

- `viewBox` 是 `[宽, 高]` 两元素。宽度上限受 1440×900 最小投影字号约束，当前 1340 是上界。
- 只走正交连线；同一走廊的边共用一条通道 x，标签放末段或靠 `labelDx` 横移，不要放在出边首段。
- 这些是踩过的坑，具体数值以 `validate` 回执为准，不要凭本文件记忆改。
