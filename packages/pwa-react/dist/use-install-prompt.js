/**
 * 安装引导（Android/桌面走原生 beforeinstallprompt；iOS 无原生事件，给图文引导）。
 *
 * - 已以独立窗口运行（standalone）不出任何引导；
 * - iOS 引导按版本记忆「本版本已关闭」，新版发布后允许再提示一次；
 * - 何时自动弹 iOS 引导由宿主决定（在用户完成一次有价值的操作之后调 openIosGuide），
 *   本 hook 不自作主张打扰。
 */
import { iosBrowser, isIOS, isStandalone } from "@nexus-kit/pwa";
import { useCallback, useEffect, useState } from "react";
function readStandalone() {
    if (typeof window === "undefined")
        return false;
    return isStandalone(navigator, window.matchMedia?.("(display-mode: standalone)").matches ?? false);
}
export function useInstallPrompt(options) {
    const storageKey = options.storageKey ?? "nexus-install-guide-dismissed-version";
    const [standalone] = useState(readStandalone);
    const [ios] = useState(() => typeof navigator !== "undefined" && isIOS(navigator));
    const [browser] = useState(() => (ios ? iosBrowser(navigator) : null));
    const [event, setEvent] = useState(null);
    const [iosGuideOpen, setIosGuideOpen] = useState(false);
    const [iosGuideDismissed, setDismissed] = useState(() => {
        try {
            return window.localStorage.getItem(storageKey) === options.version;
        }
        catch {
            return false;
        }
    });
    const { onInstalled } = options;
    useEffect(() => {
        if (standalone)
            return;
        const onBefore = (e) => {
            e.preventDefault();
            setEvent(e);
        };
        const onDone = () => {
            setEvent(null);
            onInstalled?.();
        };
        window.addEventListener("beforeinstallprompt", onBefore);
        window.addEventListener("appinstalled", onDone);
        return () => {
            window.removeEventListener("beforeinstallprompt", onBefore);
            window.removeEventListener("appinstalled", onDone);
        };
    }, [standalone, onInstalled]);
    const openIosGuide = useCallback(() => setIosGuideOpen(true), []);
    const dismissIosGuide = useCallback(() => {
        try {
            window.localStorage.setItem(storageKey, options.version);
        }
        catch {
            /* 隐私模式写不进：只影响下次是否再提示 */
        }
        setDismissed(true);
        setIosGuideOpen(false);
    }, [storageKey, options.version]);
    const install = useCallback(async () => {
        if (ios) {
            setIosGuideOpen(true);
            return;
        }
        if (event === null)
            return;
        // 原生安装事件只能用一次（再调 prompt() 会抛错）：无论接受还是取消都清掉，等浏览器下次再派发
        setEvent(null);
        await event.prompt();
        await event.userChoice;
    }, [ios, event]);
    return {
        standalone,
        ios,
        browser,
        canInstall: !standalone && (event !== null || ios),
        iosGuideDismissed,
        iosGuideOpen: !standalone && iosGuideOpen,
        install,
        openIosGuide,
        dismissIosGuide,
    };
}
