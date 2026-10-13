/** Chrome/Edge 触发的原生安装引导事件（标准尚未收录，自行声明） */
export interface BeforeInstallPromptEvent extends Event {
    prompt(): Promise<void>;
    userChoice: Promise<{
        outcome: "accepted" | "dismissed";
        platform: string;
    }>;
}
export interface InstallEnvLike {
    userAgent: string;
    maxTouchPoints: number;
    /** iOS Safari 私有属性：以独立窗口运行时为 true */
    standalone?: unknown;
}
/**
 * 是否已以独立窗口（PWA）方式运行。已安装用户不应再看到任何安装引导。
 * iOS Safari 读私有 standalone 标志，其余环境读 display-mode: standalone。
 */
export declare function isStandalone(env: InstallEnvLike, matchesStandaloneDisplay: boolean): boolean;
/**
 * iOS / iPadOS Safari 检测。iPadOS 13+ 的 UA 伪装成 Macintosh，
 * 需以多点触控辅助判断。
 */
export declare function isIOS(env: InstallEnvLike): boolean;
/**
 * iOS 上的浏览器种类：安装步骤因浏览器而异。
 * - wechat / qq：内置浏览器没有「添加到主屏幕」，只能先跳到系统浏览器；
 * - safari：分享按钮位置随系统版本与机型变化（底栏、地址栏旁、「⋯」菜单），文案不写死位置；
 * - other：iOS 版 Chrome/Edge/Firefox 等，分享按钮在地址栏一侧。
 */
export type IosBrowser = "safari" | "wechat" | "qq" | "other";
export declare function iosBrowser(env: InstallEnvLike): IosBrowser;
