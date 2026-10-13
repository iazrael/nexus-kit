/**
 * 升级流程状态机（机制见 docs/架构算法/离线与升级.md §4）：用户确认升级之后的
 * 下载 → 切换 → 刷新三段时序，纯逻辑、依赖全部注入、可单测。
 *
 * - **downloading**：探测（registration.update()）触发新 SW 后台安装；轮询等
 *   waiting 就绪（真机实测安装可能十几秒，version.json 嗅探先于安装完成到达）。
 *   宿主的进度条停在 ~85% 等真实事件，不造假走满。
 * - **switching**：waiting 就绪即发 SKIP_WAITING；新 SW 激活（onNewSwActivated）
 *   → reload——这是用户确认过的终点，不是自动刷新。接管信号以新 worker 的
 *   statechange("activated") 为主线，controllerchange 作补线（SW 开 clientsClaim
 *   时激活即接管本页）。downloading 阶段收到激活信号（他签先发了接管令）同样视为
 *   完成：用户已确认，重载合规。
 * - **兜底**（任何一条都走 onFail 复位，宿主收起幕布、恢复按钮，绝不把用户锁在幕布后）：
 *   ① 探测落地后 noInstallGiveUpMs 内既无 installing 也无 waiting = 服务器上没有可装
 *   的新 SW（嗅探与 SW 不同步、部署未带新 sw.js），提前收口，不陪跑到绝对兜底；
 *   ② switching 后 switchingUnlockMs 未刷新 = 接管卡死；③ 绝对 absoluteUnlockMs 无进展
 *   = 下载卡死（预缓存增量实测十几秒，30s 偏紧）。installing 在跑时只受 ③ 约束——
 *   跟着真实安装进度等，中途收口会让用户落回旧版再弹一次窗。
 * - 激活信号监听只在 start 后生效：首次安装也会 fire，不能误刷。
 * - 「新 SW 已激活」的判定（subscribeNewSwActivated）与确认重入闸（createUpgradeGate）
 *   同在本模块：两者都有明确输入输出。
 */
export type UpgradeStage = "idle" | "downloading" | "switching";
export type UpgradeFailReason = "no-install" | "switching-stuck" | "downloading-stuck";
export interface UpgradeFlowDeps {
    /** 触发 SW 更新探测（发现新版即后台安装） */
    probe(): Promise<void>;
    /** SW registration 快照；undefined = 无 SW 环境 */
    getRegistration(): {
        waiting: boolean;
        installing: boolean;
    } | undefined;
    /** 对 waiting worker 发 SKIP_WAITING（接管令） */
    skipWaiting(): void;
    /** 更新终点：整页刷新（用户已确认） */
    reload(): void;
    /** 订阅「新 SW 已激活」信号（押 statechange，controllerchange 只作补线）；
     *  返回退订函数。信号可能在任何阶段到达（他签先发接管令） */
    onNewSwActivated(listener: () => void): () => void;
}
export interface UpgradeFlowTimings {
    /** waiting 轮询间隔 */
    pollMs: number;
    /** 探测落地后既无 installing 也无 waiting 的收口时限 */
    noInstallGiveUpMs: number;
    /** switching 后等待激活信号的兜底 */
    switchingUnlockMs: number;
    /** start 后整体兜底（始终等不到 waiting） */
    absoluteUnlockMs: number;
}
export declare const DEFAULT_UPGRADE_TIMINGS: UpgradeFlowTimings;
export interface UpgradeFlow {
    start(): void;
    stage(): UpgradeStage;
}
export declare function createUpgradeFlow(deps: UpgradeFlowDeps, opts: {
    timings?: Partial<UpgradeFlowTimings>;
    onStage(stage: UpgradeStage): void;
    onFail?(reason: UpgradeFailReason): void;
}): UpgradeFlow;
/** ServiceWorker 最小形状（真实对象与测试假对象共用） */
export interface SwWorkerLike {
    readonly state: string;
    addEventListener(type: "statechange", listener: () => void): void;
    removeEventListener(type: "statechange", listener: () => void): void;
}
export interface SwRegistrationLike {
    readonly waiting: SwWorkerLike | null;
    readonly installing: SwWorkerLike | null;
    readonly active: SwWorkerLike | null;
    addEventListener(type: "updatefound", listener: () => void): void;
    removeEventListener(type: "updatefound", listener: () => void): void;
}
export interface SwContainerLike {
    readonly controller: SwWorkerLike | null;
    addEventListener(type: "controllerchange", listener: () => void): void;
    removeEventListener(type: "controllerchange", listener: () => void): void;
}
/**
 * 订阅「新 SW 已激活」：① 现有 waiting/installing 的 statechange→activated（主线）；
 * ② updatefound 给之后出生的 worker 补挂（确认早于新 SW 出生：慢链路/安装失败重来）；
 * ③ controllerchange 补线（SW 开 clientsClaim，新 SW 激活即接管本页时 fire）。
 * 订阅当下 waiting/installing 皆空时，两种情形算新 SW 已被他签激活：active **不是本页
 * controller**；或本页 controller **已不是页面加载时那个**（initialController，他签确认
 * 后新 SW 借 clientsClaim 接管了本页，本页跑的仍是旧 JS）。active 等于加载时的 controller
 * 说明新 SW 还没下来（安装失败/探测失败），此时立即刷新只会回到旧版。
 * 本页未受控（controller=null）无从判定，不立即接管，交给轮询与兜底。
 */
export declare function subscribeNewSwActivated(reg: SwRegistrationLike, container: SwContainerLike, listener: () => void, 
/** 页面加载时的 controller（缺省=不判此条） */
initialController?: SwWorkerLike | null): () => void;
/**
 * 升级确认重入闸：确认 → 存档落盘期间弹窗仍在，双击会叠两扇门（过场强拆钩子单槽，
 * 旧门泄漏=永久挡屏）。run 返回 false/抛错（存档失败）即放开，玩家可在弹窗上重试；
 * 返回 true 后保持占用（升级进行中，期间不再开弹窗），直到卡死兜底 release。
 */
export declare function createUpgradeGate(): {
    begin(run: () => Promise<boolean>): void;
    busy(): boolean;
    release(): void;
};
