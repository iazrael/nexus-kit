/**
 * 主动离场（升级、退出、返回首页）的事务门：保存明确完成后才执行跳转或刷新。保存可能既不完成也不
 * 失败（IndexedDB 悬挂），超时即失败——宁可让用户留在当前页看到「保存失败，请重试」，也不能让人
 * 点完按钮后卡在既没离开也没提示的死局里。pagehide 只作无法控制的关页兜底，应用内可控路径不靠它。
 * 超时后第一次保存可能仍在后台进行，用户重试会再发起一次：save 必须幂等，或由调用方自己加互斥。
 */
/** 默认保存等待上限 */
export declare const LEAVE_SAVE_TIMEOUT_MS = 5000;
export declare function leaveAfterSave(save: () => Promise<void>, leave: () => void | Promise<void>, options?: {
    timeoutMs?: number;
}): Promise<void>;
