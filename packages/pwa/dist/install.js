// PWA 安装环境检测的纯逻辑（规格 §5.4）：navigator 信息以参数注入以便单测。
/**
 * 是否已以独立窗口（PWA）方式运行。已安装用户不应再看到任何安装引导。
 * iOS Safari 读私有 standalone 标志，其余环境读 display-mode: standalone。
 */
export function isStandalone(env, matchesStandaloneDisplay) {
    if (typeof env.standalone === "boolean")
        return env.standalone;
    return matchesStandaloneDisplay;
}
/**
 * iOS / iPadOS Safari 检测。iPadOS 13+ 的 UA 伪装成 Macintosh，
 * 需以多点触控辅助判断。
 */
export function isIOS(env) {
    if (/iPad|iPhone|iPod/.test(env.userAgent))
        return true;
    return /Macintosh/.test(env.userAgent) && env.maxTouchPoints > 1;
}
export function iosBrowser(env) {
    const ua = env.userAgent;
    if (/MicroMessenger/i.test(ua))
        return "wechat";
    if (/\bQQ\//i.test(ua))
        return "qq";
    if (/CriOS|FxiOS|EdgiOS|OPiOS|YaBrowser|DuckDuckGo|GSA\//.test(ua))
        return "other";
    return "safari";
}
