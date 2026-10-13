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
 *   暂缓（专注流程中不打断），解除时补开；用户「稍后」关掉的同一构建 24 小时内不再
 *   自动开（只存内存，重开应用即重置），新构建立即开，手动检查命中强制再开。
 * - **验证开关 `?nosw=1`**：反注册 SW + 清空 Cache Storage + 本轮不注册，实机验收拿到的
 *   永远是服务器最新构建。
 * - 依赖（registerSW、日志、离线就绪钩子）全部注入：`virtual:pwa-register` 只在宿主
 *   的 vite 构建里可解析，由宿主 import 后传入。
 */
import { createUpgradeFlow, subscribeNewSwActivated, } from "./upgrade-flow.js";
import { collectPendingReleases, parseVersionManifest } from "./version-check.js";
const consoleLogger = {
    info: (m, d) => console.info(`[pwa] ${m}`, d ?? ""),
    warn: (m, d) => console.warn(`[pwa] ${m}`, d ?? ""),
    error: (m, d) => console.error(`[pwa] ${m}`, d ?? ""),
};
const DEFAULT_CHECK_INTERVAL_MS = 15 * 60 * 1000;
const DEFAULT_SAVE_TIMEOUT_MS = 3000;
/** 「稍后」的有效期：本次打开期间同一构建不再自动提醒，但最长 24 小时（防长时间不重开的会话永久静默） */
const DEFAULT_DISMISS_TTL_MS = 24 * 60 * 60 * 1000;
/** version.json 嗅探超时：弱网下手动检查不能长时间没反应 */
const SNIFF_TIMEOUT_MS = 10_000;
const IDLE_TIMEOUT_MS = 3000;
const IDLE_FALLBACK_MS = 1500;
const errText = (error) => String(error).slice(0, 200);
/** requestIdleCallback（iOS 16.4 前没有，退 setTimeout；timeout 兜底长时间不空闲也会执行） */
export function whenIdle(fn) {
    const w = window;
    if (typeof w.requestIdleCallback === "function")
        w.requestIdleCallback(fn, { timeout: IDLE_TIMEOUT_MS });
    else
        window.setTimeout(fn, IDLE_FALLBACK_MS);
}
export function createPwaController(options) {
    const log = options.logger ?? consoleLogger;
    const versionUrl = options.versionUrl ?? "/version.json";
    const checkIntervalMs = options.checkIntervalMs ?? DEFAULT_CHECK_INTERVAL_MS;
    const dismissTtlMs = options.dismissTtlMs ?? DEFAULT_DISMISS_TTL_MS;
    const noSwParam = options.noSwParam ?? "nosw";
    const prefix = options.storagePrefix ?? "nexus";
    const noSwReloadedKey = `${prefix}-nosw-reloaded`;
    const upgradedFromKey = `${prefix}-upgraded-from`;
    /** 升级刷新前记下旧版本，新版本启动后据此提示一次「已更新」。存储不可用只影响提示 */
    const reloadForUpgrade = () => {
        try {
            window.localStorage.setItem(upgradedFromKey, options.local.version);
        }
        catch {
            log.warn("记录升级前版本失败（只影响升级后的提示）");
        }
        location.reload();
    };
    /** 页面加载时的 SW 控制者：他签确认升级后新 SW 借 clientsClaim 接管本页时，据此认出
     *  「本页跑的是旧 JS、已被新 SW 接管」（见 subscribeNewSwActivated） */
    const initialController = typeof navigator !== "undefined" && "serviceWorker" in navigator ? navigator.serviceWorker.controller : null;
    let snapshot = { needRefresh: false, promptOpen: false, pending: null, remoteVersion: "", stage: "idle" };
    const listeners = new Set();
    const update = (patch) => {
        snapshot = { ...snapshot, ...patch };
        for (const l of [...listeners])
            l();
    };
    let registration = null;
    let started = false;
    /** 用户「稍后」关掉的远端 build 与时刻：同一构建在 dismissTtlMs 内不再自动开窗（只存内存，重开应用即重置） */
    let dismissedBuild = null;
    let dismissedAt = 0;
    let remoteBuild = -1;
    let promptBlocked = false;
    /** 升级幕布运行中：期间嗅探命中不开窗（确认窗会压在幕布后，卡死收幕后冒出一扇没点过的窗） */
    let upgradeInFlight = false;
    /** 在途探测去重：浏览器对同 registration 的并发 update() 本会去重，这里再挡一层 */
    let inflightProbe = null;
    function probeSwUpdate(source) {
        if (registration === null)
            return Promise.resolve();
        if (inflightProbe !== null)
            return inflightProbe;
        const startedAt = Date.now();
        log.info("探测新版本开始", { source });
        inflightProbe = registration
            .update()
            .then(() => log.info("探测新版本完成", { source, ms: Date.now() - startedAt }), () => {
            /* 探测失败静默：离线/瞬断是常态，下个心跳再来 */
        })
            .finally(() => {
            inflightProbe = null;
        });
        return inflightProbe;
    }
    const dismissActive = () => dismissedBuild !== null && dismissedBuild === remoteBuild && Date.now() - dismissedAt < dismissTtlMs;
    /** 开窗判定：被暂缓、升级进行中、或用户「稍后」过同一构建且未过期（非强制）都不开 */
    function requestPrompt(reason, force = false) {
        update({ needRefresh: true });
        if (upgradeInFlight) {
            log.info("升级进行中，暂不开确认窗", { reason });
            return;
        }
        if (!force && (promptBlocked || dismissActive())) {
            log.info("检测到新版本，暂不开窗", { reason, blocked: promptBlocked });
            return;
        }
        log.info("检测到新版本，开确认窗", { reason });
        update({ promptOpen: true });
    }
    /** 嗅探 version.json 并与本地指纹比对；notify=false 为静默嗅探（强制更新用） */
    async function sniffVersionManifest(notify) {
        try {
            const res = await fetch(`${versionUrl}?t=${Date.now()}`, { cache: "no-store", signal: AbortSignal.timeout(SNIFF_TIMEOUT_MS) });
            if (!res.ok) {
                log.warn("version.json 拉取失败", { status: res.status });
                return "unavailable";
            }
            const raw = await res.json();
            const manifest = parseVersionManifest(raw);
            if (manifest === null) {
                log.warn("version.json 结构非法，按无更新处理");
                return "unavailable";
            }
            const pending = collectPendingReleases(options.local, manifest);
            if (pending === null) {
                log.info("已是最新版本", {
                    local: `${options.local.version}+${options.local.build}`,
                    remote: `${manifest.version}+${manifest.build}`,
                });
                return "latest";
            }
            if (notify) {
                remoteBuild = manifest.build;
                update({ pending, remoteVersion: manifest.version.replace(/^[vV]/, "") });
                // 每次命中都走开窗判定：已开着是空操作，「稍后」未过期由 requestPrompt 拦下
                if (!snapshot.promptOpen)
                    requestPrompt("version.json 嗅探命中");
            }
            return "update";
        }
        catch (error) {
            log.warn("version.json 嗅探失败（离线或网络异常）", { error: errText(error) });
            return "unavailable";
        }
    }
    function probeAndSniff(source) {
        void probeSwUpdate(source);
        void sniffVersionManifest(true);
    }
    async function clearForNoSw() {
        const regs = await navigator.serviceWorker.getRegistrations();
        for (const r of regs)
            await r.unregister();
        const keys = await caches.keys();
        for (const k of keys)
            await caches.delete(k);
        log.info("nosw 模式：SW 已反注册、Cache Storage 已清", { sw: regs.length, caches: keys.length });
        if ((regs.length > 0 || keys.length > 0) && !sessionStorage.getItem(noSwReloadedKey)) {
            sessionStorage.setItem(noSwReloadedKey, "1");
            location.reload();
        }
    }
    function start() {
        if (started)
            return;
        started = true;
        if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) {
            log.info("环境不支持 ServiceWorker，PWA 关闭（局域网 HTTP 属已知边界）");
            return;
        }
        if (new URLSearchParams(location.search).has(noSwParam)) {
            void clearForNoSw().catch((error) => log.error("nosw 清理失败", { error: errText(error) }));
            return;
        }
        document.addEventListener("visibilitychange", () => {
            if (document.visibilityState === "visible" && registration !== null)
                probeAndSniff("foreground");
        });
        options.registerSW({
            onRegisteredSW: (swScriptUrl, reg) => {
                registration = reg ?? null;
                log.info("SW 已注册", { sw: swScriptUrl, scope: reg?.scope });
                if (registration === null)
                    return;
                probeAndSniff("register");
                setInterval(() => probeAndSniff("interval"), checkIntervalMs);
            },
            onRegisterError: (error) => log.error("SW 注册失败", { error: String(error).slice(0, 300) }),
            onOfflineReady: () => {
                log.info("离线就绪（壳预缓存完成）");
                options.onOfflineReady?.();
            },
            onNeedRefresh: () => {
                // waiting 就绪（新壳已装好）。已有更新说明直接开窗；否则等嗅探补上说明再开
                if (snapshot.pending !== null || snapshot.remoteVersion !== "")
                    requestPrompt("SW waiting 就绪");
                else
                    log.info("新 SW 已就绪待应用（version.json 嗅探尚未命中，等下一拍）");
            },
        });
    }
    async function checkForUpdate(source, opts = {}) {
        void probeSwUpdate(source);
        const sniffed = await sniffVersionManifest(!opts.quiet);
        if (sniffed === "update")
            return "update";
        if (registration?.waiting != null || snapshot.needRefresh)
            return "update";
        return sniffed === "latest" ? "latest" : "failed";
    }
    async function ensureRegistration() {
        if (registration !== null)
            return true;
        if (typeof navigator === "undefined" || !("serviceWorker" in navigator))
            return false;
        try {
            const reg = await navigator.serviceWorker.getRegistration();
            if (reg === undefined)
                return false;
            registration = reg;
            log.info("接管既有 SW 注册（本会话尚未接线）", { scope: reg.scope });
            return true;
        }
        catch (error) {
            log.warn("查询既有 SW 注册失败，按无注册处理", { error: errText(error) });
            return false;
        }
    }
    function beginUpgrade(handlers = {}) {
        if (registration === null) {
            // 无 SW 即无预缓存钉死，刷新拿到的就是服务器最新构建（用户已确认）
            log.info("无 SW 注册，直接刷新取最新构建");
            reloadForUpgrade();
            return;
        }
        upgradeInFlight = true;
        update({ promptOpen: false });
        const reg = registration;
        const flow = createUpgradeFlow({
            probe: async () => {
                try {
                    await reg.update();
                }
                catch (error) {
                    log.warn("升级探测失败", { error: errText(error) });
                }
            },
            getRegistration: () => ({ waiting: reg.waiting !== null, installing: reg.installing !== null }),
            // 只发接管令；刷新押在激活信号上（statechange 主线 + controllerchange 补线）
            skipWaiting: () => reg.waiting?.postMessage({ type: "SKIP_WAITING" }),
            reload: reloadForUpgrade,
            onNewSwActivated: (listener) => subscribeNewSwActivated(reg, navigator.serviceWorker, listener, initialController),
        }, {
            ...(options.timings ? { timings: options.timings } : {}),
            onStage: (stage) => {
                update({ stage });
                handlers.onStage?.(stage);
            },
            // 先清进行中标志再通知宿主：卡死收幕后心跳/手动检查命中要能重新开窗
            onFail: (reason) => {
                upgradeInFlight = false;
                log.warn("升级流程兜底收口", { reason });
                handlers.onFail?.(reason);
            },
        });
        flow.start();
    }
    async function saveBefore(hook, timeoutMs) {
        let timer;
        const timeout = new Promise((resolve) => {
            timer = setTimeout(() => resolve("timeout"), timeoutMs);
        });
        try {
            const r = await Promise.race([hook().then(() => "saved"), timeout]);
            if (r === "timeout")
                log.warn("强制更新：保存超时，放行更新", { ms: timeoutMs });
        }
        catch (error) {
            log.warn("强制更新：保存失败，放行更新", { error: errText(error) });
        }
        finally {
            clearTimeout(timer);
        }
    }
    return {
        start,
        startWhenIdle: () => whenIdle(start),
        getSnapshot: () => snapshot,
        subscribe(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        checkForUpdate,
        async manualCheck() {
            const state = await checkForUpdate("manual");
            if (state === "update")
                requestPrompt("手动检查命中", true);
            return state;
        },
        dismissPrompt() {
            dismissedBuild = remoteBuild;
            dismissedAt = Date.now();
            update({ promptOpen: false });
        },
        reopenPrompt() {
            if (snapshot.needRefresh)
                requestPrompt("用户重开", true);
        },
        consumeUpdatedNotice() {
            let from;
            try {
                from = window.localStorage.getItem(upgradedFromKey);
                if (from !== null)
                    window.localStorage.removeItem(upgradedFromKey);
            }
            catch {
                return null;
            }
            // 版本没变 = 刷新后仍是旧版（升级没生效），不报喜
            if (from === null || from === options.local.version)
                return null;
            return { from, to: options.local.version };
        },
        setPromptBlocked(blocked) {
            promptBlocked = blocked;
            if (!blocked && snapshot.needRefresh && !snapshot.promptOpen)
                requestPrompt("暂缓解除");
        },
        ensureRegistration,
        beginUpgrade,
        async forceUpgrade(opts = {}) {
            // SW 按浏览器真实注册判定且先接管再判定：只看本会话变量会把持有旧壳的回头客误判成无 SW
            await ensureRegistration();
            const state = await checkForUpdate("force", { quiet: true });
            if (state !== "update")
                return state;
            if (opts.beforeReload)
                await saveBefore(opts.beforeReload, opts.saveTimeoutMs ?? DEFAULT_SAVE_TIMEOUT_MS);
            beginUpgrade(opts);
            return "started";
        },
    };
}
