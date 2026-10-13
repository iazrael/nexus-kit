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
import { createUpgradeGate } from "@nexus-kit/pwa";
import { useCallback, useMemo, useRef, useState, useSyncExternalStore } from "react";
/** 升级前保存的默认等待上限 */
export const DEFAULT_SAVE_TIMEOUT_MS = 5000;
export function usePwaSnapshot(controller) {
    return useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
}
function withTimeout(task, ms) {
    let timer;
    return Promise.race([
        task().catch(() => false),
        new Promise((resolve) => {
            timer = setTimeout(() => resolve(false), ms);
        }),
    ]).finally(() => clearTimeout(timer));
}
export function usePwaUpdate(controller, options = {}) {
    const saveTimeoutMs = options.saveTimeoutMs ?? DEFAULT_SAVE_TIMEOUT_MS;
    const snapshot = usePwaSnapshot(controller);
    const gate = useMemo(() => createUpgradeGate(), []);
    const [failReason, setFailReason] = useState(null);
    const [busy, setBusy] = useState(false);
    const [saving, setSaving] = useState(false);
    /** 每次 confirm 一个代际号；dismiss 推进代际，在途保存落地后发现代际变了就不再开跑 */
    const generation = useRef(0);
    const confirm = useCallback((beforeUpgrade) => {
        if (gate.busy())
            return;
        const gen = ++generation.current;
        setFailReason(null);
        setBusy(true);
        gate.begin(async () => {
            if (beforeUpgrade)
                setSaving(true);
            const ok = beforeUpgrade ? await withTimeout(beforeUpgrade, saveTimeoutMs) : true;
            if (gen !== generation.current)
                return false; // 保存期间用户点了「稍后」
            setSaving(false);
            if (!ok) {
                setBusy(false);
                setFailReason("save-failed");
                return false;
            }
            controller.beginUpgrade({
                onFail: (reason) => {
                    gate.release();
                    setBusy(false);
                    setFailReason(reason);
                },
            });
            return true;
        });
    }, [controller, gate, saveTimeoutMs]);
    const dismiss = useCallback(() => {
        if (snapshot.stage !== "idle")
            return; // 已进入下载/切换：用户授权过刷新，不可取消
        generation.current += 1;
        gate.release();
        setBusy(false);
        setSaving(false);
        setFailReason(null);
        controller.dismissPrompt();
    }, [controller, gate, snapshot.stage]);
    const forceUpgrade = useCallback((beforeUpgrade) => {
        setFailReason(null);
        return controller.forceUpgrade({
            ...(beforeUpgrade ? { beforeReload: async () => void (await beforeUpgrade()) } : {}),
            saveTimeoutMs,
            onFail: (reason) => setFailReason(reason),
        });
    }, [controller, saveTimeoutMs]);
    return {
        snapshot,
        failReason,
        saving,
        confirm,
        dismiss,
        reopen: useCallback(() => controller.reopenPrompt(), [controller]),
        manualCheck: useCallback(() => controller.manualCheck(), [controller]),
        forceUpgrade,
        busy,
    };
}
