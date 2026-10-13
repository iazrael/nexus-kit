import { usePwaUpdate } from "@nexus-kit/pwa-react";
import { useEffect, useState } from "react";
import { APP_BUILD, APP_VERSION } from "./build-info.ts";
import { InstallGuide } from "./components/InstallGuide.tsx";
import { UpdateDialog } from "./components/UpdateDialog.tsx";
import { pwa } from "./pwa.ts";

const CHECK_TEXT = { update: "", latest: "已是最新版本", failed: "网络不通，连上网后再试" } as const;
const NOTICE_MS = 4000;

/** 升级成功后的一次性提示：由升级刷新进来、且版本确实变了才出现 */
const updatedNotice = pwa.consumeUpdatedNotice();

export function App() {
  const { snapshot, reopen } = usePwaUpdate(pwa);
  const [checking, setChecking] = useState(false);
  const [notice, setNotice] = useState(updatedNotice === null ? "" : `已更新到 ${updatedNotice.to}`);

  useEffect(() => {
    if (notice === "") return;
    const t = setTimeout(() => setNotice(""), NOTICE_MS);
    return () => clearTimeout(t);
  }, [notice]);

  const check = (): void => {
    setChecking(true);
    void pwa.manualCheck().then((r) => {
      setChecking(false);
      setNotice(CHECK_TEXT[r]); // 命中时弹窗已打开，不再重复提示
    });
  };

  return (
    <div className="safe-area flex flex-col">
      <main className="flex flex-1 flex-col items-center justify-center gap-4 p-6 text-center">
        <h1 className="text-2xl font-bold">Nexus App</h1>
        <p className="text-sm text-zinc-400">从 nexus-kit 模板生成。改完首页，记得同步需求文档。</p>
      </main>
      <footer className="flex flex-wrap items-center justify-center gap-4 p-4 text-xs text-zinc-500">
        <span data-testid="app-version" data-version={`${APP_VERSION}+${APP_BUILD}`}>
          版本 {APP_VERSION.replace(/^v/, "")}（构建 {APP_BUILD}）
        </span>
        {snapshot.needRefresh && !snapshot.promptOpen && snapshot.stage === "idle" ? (
          <button type="button" className="rounded bg-amber-500/20 px-2 py-0.5 text-amber-300 active:opacity-70" onClick={reopen}>
            有新版本
          </button>
        ) : (
          <button
            type="button"
            className="underline underline-offset-2 active:opacity-70 disabled:opacity-50"
            disabled={checking}
            onClick={check}
          >
            {checking ? "检查中…" : "检查更新"}
          </button>
        )}
        <InstallGuide />
        {notice !== "" && <span role="status">{notice}</span>}
      </footer>
      <UpdateDialog controller={pwa} />
    </div>
  );
}
