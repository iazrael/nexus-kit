/**
 * PWA 控制器（机制见 docs/架构算法/离线与升级.md §4/§6）：SW 注册、更新检测、升级
 * 执行与可观察性的唯一接线处。框架无关——React 绑定在 @nexus-kit/pwa-react。
 *
 * - **检测链**（合流去重）：SW waiting 事件 + 心跳轮询（默认 15 分钟）+ 切前台探测 +
 *   手动检查；探测后嗅探 version.json 与本地指纹比对，跨版本与同版本重发都能识别。
 *   网络失败静默（只进日志）。
 * - **prompt 制红线**：没有用户主动点击的路径不得自动 reload。刷新只发生在用户确认
 *   之后——升级弹窗点「确定」，或「强制更新」按钮点击本身即授权。
 * - **弹窗时机**由快照的 promptOpen 表达：检测命中即开；宿主可 setPromptBlocked
 *   暂缓（专注流程中不打断），解除时补开；用户「稍后」关掉的同一构建不再自动开，
 *   手动检查命中强制再开。
 * - **验证开关 `?nosw=1`**：反注册 SW + 清空 Cache Storage + 本轮不注册，实机验收拿到的
 *   永远是服务器最新构建。
 * - 依赖（registerSW、日志、离线就绪钩子）全部注入：`virtual:pwa-register` 只在宿主
 *   的 vite 构建里可解析，由宿主 import 后传入。
 */
import { type UpgradeFailReason, type UpgradeFlowTimings, type UpgradeStage } from "./upgrade-flow.ts";
import { type LocalFingerprint, type PendingUpdate } from "./version-check.ts";
/** 结构化日志口：宿主接自己的日志系统；缺省落 console（错误不许静默吞掉） */
export interface PwaLogger {
    info(message: string, data?: Record<string, unknown>): void;
    warn(message: string, data?: Record<string, unknown>): void;
    error(message: string, data?: Record<string, unknown>): void;
}
/** vite-plugin-pwa `virtual:pwa-register` 的 registerSW 形状（只取本模块用到的回调） */
export interface RegisterSwOptions {
    immediate?: boolean;
    onRegisteredSW?: (swScriptUrl: string, registration: ServiceWorkerRegistration | undefined) => void;
    onRegisterError?: (error: unknown) => void;
    onOfflineReady?: () => void;
    onNeedRefresh?: () => void;
}
export type RegisterSw = (options: RegisterSwOptions) => unknown;
export interface PwaControllerOptions {
    /** 本地构建指纹（构建期注入的 version/build/notesDigest，见 @nexus-kit/vite） */
    local: LocalFingerprint;
    /** `import { registerSW } from "virtual:pwa-register"` */
    registerSW: RegisterSw;
    logger?: PwaLogger;
    /** version.json 站内路径，默认 /version.json */
    versionUrl?: string;
    /** 心跳间隔，默认 15 分钟 */
    checkIntervalMs?: number;
    /** 验证开关 URL 参数名，默认 nosw */
    noSwParam?: string;
    /** sessionStorage 键前缀（nosw 防循环重载），默认 nexus */
    storagePrefix?: string;
    /** 壳预缓存首次装好（离线就绪）：宿主可在这里做离线补缓存（见 offline-warm.ts） */
    onOfflineReady?: () => void;
    /** 升级状态机时序覆盖（测试/特殊部署用） */
    timings?: Partial<UpgradeFlowTimings>;
}
/** 控制器对外快照（不可变对象，每次变化换新引用，供 useSyncExternalStore） */
export interface PwaSnapshot {
    /** 已检测到新版本（SW waiting 或 version.json 嗅探命中） */
    readonly needRefresh: boolean;
    /** 弹窗应处于打开态 */
    readonly promptOpen: boolean;
    /** 待展示的更新（版本组 + 折叠数 + 类型）；null = 只知道有更新、没拿到说明 */
    readonly pending: PendingUpdate | null;
    /** 远端版本串（不带 v 前缀）；未知为空串 */
    readonly remoteVersion: string;
    /** 升级状态机阶段 */
    readonly stage: UpgradeStage;
}
export type CheckResult = "update" | "latest" | "failed";
export interface UpgradeHandlers {
    onStage?(stage: UpgradeStage): void;
    onFail?(reason: UpgradeFailReason): void;
}
export interface ForceUpgradeOptions extends UpgradeHandlers {
    /** 刷新前的保存钩子（失败/超时只记日志、照常更新——强制更新是逃出旧版缺陷的出口） */
    beforeReload?: () => Promise<void>;
    /** 保存等待上限，默认 3 秒 */
    saveTimeoutMs?: number;
}
export interface PwaController {
    /** 注册 SW 并启动检测链；无 SW 环境为 no-op。只应调用一次 */
    start(): void;
    /** 空闲后再 start：首访时 SW 预缓存与首屏抢带宽，让首屏先跑完 */
    startWhenIdle(): void;
    getSnapshot(): PwaSnapshot;
    subscribe(listener: () => void): () => void;
    /** 判定核：嗅探即答，壳探测放后台不等待。quiet = 只判定不开窗不记 pending */
    checkForUpdate(source: string, opts?: {
        quiet?: boolean;
    }): Promise<CheckResult>;
    /** 手动「检查更新」：判定 + 命中强制开窗（「稍后」关掉过也重开） */
    manualCheck(): Promise<CheckResult>;
    /** 用户「稍后」：关窗，同一构建不再自动开 */
    dismissPrompt(): void;
    /** 重开弹窗（「稍后」之后用户主动回来更新）：已知有更新时直接开，不重新请求网络 */
    reopenPrompt(): void;
    /** 读取并清除「刚升级完」标记：本次启动是由升级刷新进来、且版本确实变了时返回新旧版本 */
    consumeUpdatedNotice(): {
        from: string;
        to: string;
    } | null;
    /** 暂缓/恢复自动开窗（专注流程中不打断）；恢复时有未处理更新则补开 */
    setPromptBlocked(blocked: boolean): void;
    /** 确保拿到浏览器真实 SW 注册（本会话未接线时接管既有注册） */
    ensureRegistration(): Promise<boolean>;
    /** 用户确认升级后调用（保存由宿主先行）。无 SW 注册时直接刷新收口 */
    beginUpgrade(handlers?: UpgradeHandlers): void;
    /** 「强制更新」：点击即授权，命中直接开跑；返回 started/latest/failed */
    forceUpgrade(opts?: ForceUpgradeOptions): Promise<"started" | CheckResult>;
}
/** requestIdleCallback（iOS 16.4 前没有，退 setTimeout；timeout 兜底长时间不空闲也会执行） */
export declare function whenIdle(fn: () => void): void;
export declare function createPwaController(options: PwaControllerOptions): PwaController;
