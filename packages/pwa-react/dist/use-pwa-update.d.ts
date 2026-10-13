/**
 * React 绑定：订阅 PWA 控制器快照，并把「确认升级」收成一个带重入闸的动作。
 *
 * 用法：控制器在模块顶层创建一次（createPwaController），组件里
 * `const pwa = usePwaUpdate(controller)`，用 pwa.snapshot.promptOpen 控制弹窗，
 * 「确定」调 pwa.confirm(保存钩子)、「稍后」调 pwa.dismiss()。样式由宿主自己写。
 *
 * 保存段同样不许把用户锁住：保存有超时（超时按失败处理），保存期间「稍后」可点——
 * 点了就取消本次升级，保存落地后也不再开跑。
 */
import { type CheckResult, type PwaController, type PwaSnapshot, type UpgradeFailReason } from "@nexus-kit/pwa";
/** 升级前保存的默认等待上限 */
export declare const DEFAULT_SAVE_TIMEOUT_MS = 5000;
/** 宿主可见的失败原因：升级状态机的三种卡死 + 保存失败 */
export type UpdateFailReason = UpgradeFailReason | "save-failed";
export declare function usePwaSnapshot(controller: PwaController): PwaSnapshot;
export interface UsePwaUpdateOptions {
    /** 保存钩子等待上限，默认 5 秒 */
    saveTimeoutMs?: number;
}
export interface UsePwaUpdate {
    snapshot: PwaSnapshot;
    /** 最近一次失败的原因（宿主据此给可见提示）；成功路径页面刷新，不会走到这里 */
    failReason: UpdateFailReason | null;
    /** 保存进行中（按钮旁显示「正在保存…」） */
    saving: boolean;
    /** 确认升级：先跑保存钩子（返回 false/抛错/超时 = 保存失败，留在弹窗可重试），成功才开跑 */
    confirm(beforeUpgrade?: () => Promise<boolean>): void;
    /** 「稍后」：关窗、清掉失败提示；保存进行中则取消本次升级；已进入下载/切换则无效 */
    dismiss(): void;
    /** 「稍后」之后用户主动回来更新（不重新请求网络） */
    reopen(): void;
    /** 手动「检查更新」，结果供提示 */
    manualCheck(): Promise<CheckResult>;
    /** 强制更新：旧版弹窗或保存出问题时的逃生口（点击即授权，保存失败也照常更新） */
    forceUpgrade(beforeUpgrade?: () => Promise<boolean>): Promise<"started" | CheckResult>;
    /** 确认进行中（保存或升级），防双击 */
    busy: boolean;
}
export declare function usePwaUpdate(controller: PwaController, options?: UsePwaUpdateOptions): UsePwaUpdate;
