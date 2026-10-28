# 更新日志

源码改动必须附条目（precommit 门禁）。发布时整合 Unreleased 落款为 `## [版本号] - 日期`。
破坏接入方的改动记「破坏性：」开头并写迁移方法；不影响接入方的记「内部：」开头。

## [Unreleased]

- 内部：任务回归等待器在 Git 检出期间对对应任务文件的短暂缺失做有上限的重试，超限保留原错误，其他错误仍立即失败；不改变产品状态接口。

- 修复：子模块的工作树命令按 `core.worktree` 识别主工作区，并核验 Git 公共目录；列举、建树、共享项、快进合入、回收和 Claude 钩子不再误操作父仓库，缺失有效主工作区时拒绝执行。
- 内部：任务回归的假执行器先补全启动日志分片再同步建树，避免硬期限到达时定时器被阻塞而误报会话 ID 丢失；不修改产品逻辑、测试断言或时限。

- 新增：`task deliver <任务标识> --summary-file <文件>` 执行者交付关卡。依次检查摘要三段齐全且文件在工作树外、工作树干净且改动在白名单内、验收清单每行「自验结果」写了「通过：」或「不适用：」，再在新空目录复跑登记的验证命令；全部通过才追加交付摘要、标待验收并提交，失败时状态不变、不产生交付提交。新增 `task block <任务标识> --reason-file <文件>` 登记受阻：只提交任务文件，不要求工作树干净，记下未提交路径。rework 登记返工时清空「自验结果」列。派发提示词改为指引这两条命令。手工改状态头的旧交付方式仍被接受。
- 修复：操作锁写入持锁进程号，登记进程已退出的残锁（例如 deliver 复跑时被硬期限杀掉）下次操作自动回收；没有进程号的旧锁仍拒绝。
- 新增：`task.preflight` 配置（argv 数组，默认不配），dispatch（含 --dry-run）前在调用仓库根目录运行（正式派发先确认任务不在运行），环境变量带 TASK_ID 与 TASK_FILE，失败即拒绝派发。不配时配置指纹不变；宿主配上后 nexus.config.json 变化，在跑任务需重新确认定义。
- 修改：`task new` 模板「已批准计划与授权」改为「设计与授权」，验收清单加「自验结果」列；规则模板 `任务协作规则.md` 改成「怎么做 3 条 + 注意 3 条」，工具已检查的事项不再写进规则。已拷贝规则模板的宿主需自行同步，旧任务文件要用 deliver 时先在验收清单补「自验结果」列。
- 修改：task watch 用法改为协调者在当前回合前台运行并加 `--timeout-minutes`，退出 3 再跑一轮，watch 退出前不结束回复；去掉「调用方后台工具唤醒会话」的说法。CloudCLI 上的 Codex 一轮结束后不续开会话，还会清理后台 watch。只改 help 文案与文档，行为不变。
- 新增：task 交付摘要。执行者每轮标待验收前，在任务文件「交付与验收记录」末尾追加改了什么、验证如何、还有什么三段摘要，随交付提交；最终回复给交付 SHA 并复述摘要。格式只写在规则模板里，工具不校验摘要。
- 修改：精简 task 文本。派发提示词去掉与规则文件重复的行为规则和 scope 全文；规则模板 `任务协作规则.md` 只留执行者规则并改成清单，协调者规则见《任务协作》；`task new` 模板去掉写给协调者的长说明，开头加「一页摘要」，任务配置 JSON 挪到交付物之后、执行记录之前。已拷贝规则模板的宿主需自行同步；已有任务文件不改写；已派发任务在下次 resume 时拿到新提示词。

## [0.9.0] - 2026-10-20

- 修复：worktree merge 快进后重读主仓库的 nexus.config.json，按合入后的配置执行 postMerge（原来用合入前读到的配置，合入改了 postMerge 时会跑旧命令）；重读失败直接报错，不回退旧命令。
- 新增：`worktree.isolatable` 配置（缺省等于 `share`），isolate 与建树 `--isolate` 只接受其中的项，只读的档案、原料留在 share 里但不可隔离。
- 修复：isolate 复制只展开最顶层软链，源目录内部的软链会原样指回主仓库或仓库外，本树写入漏回原处。现在复制前遍历源目录，有任何软链即拒绝并列出路径与指向（`--empty` 不复制不检查）。
- 修复：install-hooks 写入的 pre-commit 不再用 `npx --no-install`（只认 node_modules，走 PATH 的项目会被拦下每次提交）；改为先找 `node_modules/.bin/nexus-devflow`，没有再用 PATH 上的 `nexus-devflow`，都没有时提示 `pnpm install-cli` 并非零退出。已装旧钩子的宿主（被旧钩子拦住提交时只看到 npx 的报错）：重跑 `nexus-devflow install-hooks`，它会把旧 pre-commit 报为过期，按提示用 `PRE_COMMIT` 导出替换。

## [0.8.0] - 2026-10-20

- 新增：kit 根目录 `pnpm install-cli`，建立或修复 `nexus-devflow` 全局命令：软链永远指向 kit 主仓库的 `packages/devflow/dist/cli.js`（在工作树里执行也一样），默认放 `~/.local/bin`（`--bin-dir` 可改）；同名软链替换、普通文件拒绝；目录不在 PATH 或被同名命令遮住时打印处理办法并非零退出；最后自检 `nexus-devflow --help`。
- 修复：`nexus-devflow --help` 打印用法后以 0 退出，不再按未知子命令报错退出 2。
- 修复：worktree rm 在调用方当前目录位于待删工作树内时拒绝执行并提示先 cd 回主仓库，不再删掉调用方 shell 的工作目录导致后续命令全部 spawn ENOENT。
- 新增：task 执行器接口。配置从 task.agy 单段改为 task.executor（默认执行器名）加 task.executors（每个执行器的启动命令、必填模型与权限参数），内置 agy 与 opencode 双适配器；只写旧 task.agy 段的配置按单执行器等价读取；0.7.0 冻结的派发快照在宿主 nexus.config.json 不改动时直接加载与续跑。任务 execution 段可覆盖执行器与模型，dispatch/resume 加 `--model`（已有快照换模型须同时 `--refresh-definition`；执行器在 task start 建树前就失败、任务分支尚不存在时，可在主仓 `dispatch --refresh-definition --model` 重新确认后重派）。
- 新增：opencode 以非零退出码失败时，运行记录的 error 追加执行器最后一条报错事件（类型与原文，清洗控制字符并截断）；限流（provider.quota）另附换模型重派的命令提示。task status、task watch 与 notify.log 随之可见。
- 新增：每次运行收尾写结束分类 endReason（delivered/blocked/interrupted/needs_approval/failed）并追加一行到该任务控制目录下的 notify.log（`<controlDir>/<任务标识>/notify.log`）；`task status` 在进程状态后显示分类。needs_approval 识别“退出码 0 却停在计划确认”的运行，只是给协调者的诊断提示，不改写真实退出码、不授予任何权限。结束流水写入失败保留诊断不改变收尾。
- 新增：`nexus-devflow task watch <任务标识...> | --all` 观察器，轮询运行记录，任务结束打印一行摘要后退出，供调用方后台工具等待唤醒会话；监督进程已退出而记录停在运行中时按中断结束；取消观察不终止执行器。
- 破坏性：dispatch/resume 等待结束后返回的 result 字段由 agy 原始 JSON（conversation_id、status、response 等）改为执行器单据 `{ conversationId, response }`。迁移：读取 result.conversation_id 的调用方改读 result.conversationId；result.status 不再提供，成功与否看外层 state 与 commandExitCode。
- 新增：任务配置可选 deletable 删除授权。可写白名单只授权新增和修改，删除基准已有文件须逐个列入 deletable，否则验证报“删除未授权”；重命名按删除旧路径处理。未声明 deletable 的旧任务定义，字段与定义指纹保持不变。
- 新增：task.executorEnvDeny 配置（字符串数组，默认空），启动执行器前逐个剔除这些环境变量，协调者 shell 中的授权不再被执行器继承。
- 变更：派发与续跑提示词写明派发即批准任务文件列出的计划与范围，执行者记录步骤后继续实施、不结束回合等待重复批准；`task new` 生成的模板增加背景与证据、已批准计划与授权、输入与操作步骤、验收清单、交付物与失败处理五节。

## [0.7.0] - 2026-10-15

- 修复：task dispatch（含预览）、resume、verify、accept 提示固定起点脱离当前主仓历史的风险，stderr 与 JSON 保留两个 SHA 和原树处理步骤；不自动改写基准或拒绝有效交付。
- 修复：task 待验收启动报错给出正式返工 JSON 必填项及 rework、resume 路径；输入、配置、规则、验证日志、产物和审计的 SHA-256 错误打印期望值与实际值。
- 内部：补充独立后台派发与输出重定向、共享额度、长命令检查点、主仓新增提交核对及改写历史后的集成规则；命令替换通过公开 CLI 回归验证。

- 修复：task 执行窗口内主仓只快进出新提交且工作区干净时，审计不再判 failed，改为在 run.json 的 mainWarning、等待输出和 status --short 列出新增提交；未提交改动、隐藏索引、切分支和改写历史仍判异常，复跑命令的审计不放宽。
- 修复：task 中断记录在执行器进程组确认退出后才提交，不再与残留后代抢写任务树。
- 修复：task dispatch/start 拒绝既未提交也未被 Git 忽略的输入，避免复制进任务树后 verify 永远失败。
- 修复：task status 单个任务读取失败只在该行报错；规则文件按 task.rules 排除。
- 修复：task 分钟类配置上限 35791、验证期限上限 2147483 秒，超出 Node 定时器上限的值拒绝，不再让执行器一启动就被终止；已有配置超限时所有 task 命令报配置错误，按提示改小即可。残锁报错给出锁路径与清理条件。
- 修复：task 判断任务、规则和输入是否已提交时不再受 core.quotepath 转义和通配符影响；git 默认配置下中文规则文件名不再被误报未提交。只暂存未提交的输入按未提交处理。
- 修复：task status 指定任务读取失败时退出 1；accept 输出与 stderr 列出该任务执行期间的主仓快进提醒。
- 修复：task 派发、续跑与独立复跑审计主仓受跟踪文件、暂存区及 HEAD；直接写主仓或把改动提交不能绕过验证。异常保留原始记录，协调者用 verify --main-review 明确登记核对依据后复跑，验收绑定审计与核对记录指纹。

- 新增：devflow 的 `task new|dispatch|start|status|resume|rework|verify|accept`，取材 旧项目C 的真实任务管线。宿主使用可选 task 配置，任务树独立配置目录和准备命令；agy 原会话续跑、失败留档、独立复跑与提交绑定验收。
- 新增：任务状态分别展示最近进程、最近复跑和正式验收；任务树回收后明确历史已集成或当前无法对账。
- 内部：真实子进程任务集成测试与 c8 四项覆盖率门禁纳入 check，需求、架构、规范与可选接入示例同步。

## [0.6.0] - 2026-10-14

- 新增：`@nexus-kit/runtime/assets` 图像资源。`createLoader`：加载调度器，任务按档位（0 挡门 / 1 可见 / 2 附近 / 3 空闲）与次序值排队，在飞的不打断，并发上限默认 6；同一 key（通常是 URL）在飞或排队时共用结果、不发第二次；每次调用可带 AbortSignal，全部取消且还在排队才出队；`hold` 关键闸门在关键资源有结论或封顶时限前压住档位 2、3。`createImageCache`：下载并解码成 ImageBitmap，引用计数持有，引用为零进 LRU，超预算淘汰时立即 `close()` 并通知宿主；失败不进缓存。`mapLimit`（限并发、按序返回）与 `whenIdle`（空闲执行，老 iOS 退定时器）。传入 `perf` 时登记 `assets.bitmapMB`、`assets.bitmaps`、`assets.queued`、`assets.running` 进水位长线。
- 新增：`@nexus-kit/runtime/audio` 音频。`createAudioHost`：惰性创建 AudioContext，`unlock()` 在手势里调；回前台（`visibilitychange` 与 `statechange`）对任何非 running 状态（含 iOS 的 `interrupted`）resume，落地仍不行就换新 context（上限 3 次）并广播 `onRebuild`；master 与分轨总线，按来源登记的下潜取最深一档；`whenRunning` 发声前置门；可选 `suspendWhenHidden`；`resetSession()` 处理 iOS 停麦后输出变轻。`createSamplePlayer`：解码缓存按字节预算 LRU、在途去重、引擎重建全清；HTTP 错误与解码失败永不重试，已知缺失直接静默；音效同 key 限频（墙钟）、补播时限 300ms、同时发声上限按优先级与音量抢占、句柄淡出停止；预热经 `/assets` 调度器排队，真触发直接下载并撤回排队中的同 key 预热；音乐记意图、取号仲裁晚到的解码、单次曲播完撤意图、回到 running 与重建后校对重播；`audio.decodedMB` 进水位。音量偏好的解析、钳制与「全默认不写」序列化。
- 新增：`/assets` 调度器的 `state(key)`：查任务在排队还是在飞。
- 内部：`pnpm e2e` 增加音频一条（Chromium：解锁补播、限频与发声上限、节点回收、补播时限、永不重试、挂起先唤醒、假死重建续播、指标进水位）。
- 内部：`pnpm e2e` 增加图像资源一条（慢网下关键闸门、并发上限、同图只下一次、淘汰即关位图、指标进水位）。

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
