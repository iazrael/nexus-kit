/**
 * 升级弹窗：检测到新版本时打开，列出「当前版本 → 最新版本」之间的全部更新说明。
 * 「立即更新」→ 保存钩子（有本地数据的应用在这里落盘；失败或超时留在弹窗可重试）→ 升级
 * 状态机；进度文案跟随真实阶段，不造假百分比。失败给出原因与脱困办法。
 * 「强制更新」入口由项目自己决定挂在哪（设置页、调试面板等），调 usePwaUpdate(pwa).forceUpgrade。
 */
import type { PwaController } from "@nexus-kit/pwa";
import { usePwaUpdate } from "@nexus-kit/pwa-react";
import { APP_VERSION } from "../build-info.ts";

const STAGE_TEXT = { idle: "", downloading: "正在下载新版本，通常十几秒，请别关掉应用…", switching: "正在切换到新版本…" } as const;
const FAIL_TEXT = {
  "save-failed": "进度没保存成功，为了不丢数据先不更新。可以再点一次试试。",
  "no-install": "新版本还在发布中，过几分钟再点更新就行。",
  "downloading-stuck": "网络有点慢，新版本没下完。连上稳定的网络后再点更新，或者彻底关掉应用（从多任务界面划掉）再打开。",
  "switching-stuck": "新版本已经下载好了，彻底关掉应用（从多任务界面划掉）再打开就能用上。",
} as const;

export interface UpdateDialogProps {
  controller: PwaController;
  /** 升级前保存；返回 false = 保存失败，留在弹窗 */
  beforeUpgrade?: () => Promise<boolean>;
}

export function UpdateDialog({ controller, beforeUpgrade }: UpdateDialogProps) {
  const { snapshot, confirm, dismiss, busy, saving, failReason } = usePwaUpdate(controller);
  const upgrading = snapshot.stage !== "idle";
  if (!snapshot.promptOpen && !upgrading && failReason === null) return null;
  const pending = snapshot.pending;
  const local = APP_VERSION.replace(/^v/, "");
  const remote = snapshot.remoteVersion;
  const subtitle =
    pending?.kind === "hotfix"
      ? `v${remote} · 问题修复更新`
      : pending?.kind === "revised"
        ? `v${remote} · 本版内容有更新`
        : remote !== ""
          ? `当前 v${local} → 最新 v${remote}`
          : "";
  const [latest, ...older] = pending?.releases ?? [];

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="update-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
    >
      <div className="w-full max-w-sm rounded-lg bg-zinc-900 p-5 shadow-xl">
        <h2 id="update-title" className="text-lg font-bold">
          发现新版本
        </h2>
        {subtitle !== "" && <p className="mt-1 text-xs text-zinc-400">{subtitle}</p>}
        <div className="mt-3 max-h-64 overflow-y-auto text-sm">
          {pending === null ? (
            <p className="text-zinc-300">检测到新版本，但暂时拿不到更新说明。</p>
          ) : latest === undefined ? (
            <p className="text-zinc-300">修复了一些问题，体验更稳定。</p>
          ) : (
            <>
              <ul className="list-disc space-y-1 pl-5">
                {latest.notes.map((n) => (
                  <li key={n}>{n}</li>
                ))}
              </ul>
              {older.length > 0 && (
                <details className="mt-3">
                  <summary className="cursor-pointer text-xs text-zinc-400">
                    你错过的更早版本（{older.length + pending.hiddenCount} 个，已一并包含）
                  </summary>
                  {older.map((r) => (
                    <section key={r.version} className="mt-2">
                      <h3 className="text-xs text-zinc-500">
                        v{r.version.replace(/^v/, "")} {r.date}
                      </h3>
                      <ul className="mt-1 list-disc space-y-1 pl-5">
                        {r.notes.map((n) => (
                          <li key={n}>{n}</li>
                        ))}
                      </ul>
                    </section>
                  ))}
                </details>
              )}
            </>
          )}
        </div>
        <p className="mt-3 text-xs text-zinc-500">更新会刷新一次页面，你的数据不受影响。</p>
        {saving && <p className="mt-2 text-sm text-amber-300">正在保存…</p>}
        {upgrading && <p className="mt-2 text-sm text-amber-300">{STAGE_TEXT[snapshot.stage]}</p>}
        {failReason !== null && !upgrading && (
          <p role="alert" className="mt-2 text-sm text-red-400">
            {FAIL_TEXT[failReason]}
          </p>
        )}
        <div className="mt-4 flex justify-end gap-3">
          <button type="button" className="px-3 py-1.5 text-sm text-zinc-300 disabled:opacity-40" disabled={upgrading} onClick={dismiss}>
            稍后
          </button>
          <button
            type="button"
            className="rounded bg-amber-500 px-3 py-1.5 text-sm font-bold text-black disabled:opacity-40"
            disabled={busy || upgrading}
            onClick={() => confirm(beforeUpgrade)}
          >
            立即更新
          </button>
        </div>
      </div>
    </div>
  );
}
