import { errText } from "../util.js";
const COMPONENT_STACK_MAX = 2000;
/** 跨域脚本报错时浏览器只给「Script error.」，换成能看懂的说明 */
function readable(message) {
    return message === "Script error." ? "跨域脚本报错（浏览器不提供详情）" : message;
}
export function installCrashFallback(options) {
    const log = options.store.log("lifecycle");
    const graceMs = options.graceMs ?? 1500;
    let mounted = false;
    let shown = null;
    let hide = null;
    let timer = null;
    const show = (reason, by) => {
        if (shown !== null)
            return;
        shown = by;
        if (timer !== null)
            clearTimeout(timer);
        timer = null;
        options.store.flush();
        try {
            hide = options.render(reason) ?? null;
        }
        catch (error) {
            log.error("兜底界面显示失败", { error: errText(error) });
        }
    };
    const premount = (message) => {
        if (mounted || shown !== null || timer !== null)
            return;
        log.error("应用没能启动：挂载前出现未捕获异常", { message });
        timer = setTimeout(() => {
            timer = null;
            if (mounted)
                return;
            let blank = true;
            try {
                blank = options.isBlank?.() ?? true;
            }
            catch {
                // 宿主的白屏判定自己抛错：按白屏处理——宁可多显示一次兜底，也不让真白屏漏掉
            }
            if (blank)
                show(`启动失败：${message}`, "timeout");
            else
                log.warn("挂载前的报错没有造成白屏（页面已有内容），不显示兜底", { message });
        }, graceMs);
    };
    const onError = (event) => premount(readable(event.message || errText(event.error)));
    const onRejection = (event) => premount(errText(event.reason));
    if (typeof window !== "undefined") {
        window.addEventListener("error", onError);
        window.addEventListener("unhandledrejection", onRejection);
    }
    return {
        markMounted() {
            mounted = true;
            if (timer !== null)
                clearTimeout(timer);
            timer = null;
            if (shown === "timeout" && hide !== null) {
                hide();
                hide = null;
                shown = null; // 撤下后之后真正的渲染崩溃仍要能显示兜底；挂载前路径靠 mounted 挡住，不会再触发
                log.warn("兜底显示后应用挂载成功，已撤下兜底（挂载前的报错没有阻止启动）");
            }
        },
        report(error, componentStack) {
            log.error("界面渲染崩溃", {
                error,
                ...(componentStack ? { componentStack: componentStack.slice(0, COMPONENT_STACK_MAX) } : {}),
            });
            show(`渲染崩溃：${error instanceof Error ? error.message : String(error)}`, "report");
        },
        dispose() {
            if (timer !== null)
                clearTimeout(timer);
            timer = null;
            if (typeof window !== "undefined") {
                window.removeEventListener("error", onError);
                window.removeEventListener("unhandledrejection", onRejection);
            }
        },
    };
}
