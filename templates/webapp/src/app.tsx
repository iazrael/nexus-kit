import { usePwaUpdate } from "@nexus-kit/pwa-react";
import { useEffect, useState } from "react";
import { APP_ID } from "../pwa.config.ts";
import { APP_BUILD, APP_VERSION } from "./build-info.ts";
import { InstallGuide } from "./components/InstallGuide.tsx";
import { UpdateDialog } from "./components/UpdateDialog.tsx";
import { VersionBadge } from "./components/VersionBadge.tsx";
import { exportDiagnostics, logs } from "./observe.ts";
import { pwa } from "./pwa.ts";

const CHECK_TEXT = { update: "", latest: "已是最新版本", failed: "网络不通，连上网后再试" } as const;
const NOTICE_MS = 4000;
/** 连点进度提示：超过连点窗口（2 秒）就没意义了 */
const WINDOW_HINT_MS = 2000;
/** 较长的提示（要读完去哪找文件）留久一点 */
const LONG_NOTICE_MS = 8000;
/** 下载兜底拿不到「下载成功」的信号，只能如实说「已开始」，并告诉用户去哪找、找不到怎么办 */
const EXPORT_TEXT = {
  shared: "诊断文件已分享",
  downloaded: `已开始下载诊断文件（文件名以「${APP_ID}-诊断」开头，在「下载」里找）；没看到的话，微信等应用里点右上角「···」选「在浏览器打开」后再试`,
  cancelled: "",
} as const;

/** 升级成功后的一次性提示：由升级刷新进来、且版本确实变了才出现 */
const updatedNotice = pwa.consumeUpdatedNotice();

export function App() {
  const { snapshot, reopen } = usePwaUpdate(pwa);
  const [checking, setChecking] = useState(false);
  const [notice, setNoticeState] = useState({ text: updatedNotice === null ? "" : `已更新到 ${updatedNotice.to}`, ms: NOTICE_MS });
  const setNotice = (text: string, ms = NOTICE_MS): void => setNoticeState({ text, ms });

  useEffect(() => {
    if (notice.text === "") return;
    const t = setTimeout(() => setNoticeState({ text: "", ms: NOTICE_MS }), notice.ms);
    return () => clearTimeout(t);
  }, [notice]);

  const exportLog = (): void => {
    void exportDiagnostics().then(
      (r) => setNotice(EXPORT_TEXT[r], r === "downloaded" ? LONG_NOTICE_MS : NOTICE_MS),
      (error: unknown) => {
        logs.log("app").error("导出诊断文件失败", { error: String(error) });
        setNotice("诊断文件导出失败，再试一次");
      },
    );
  };

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
      <footer className="relative flex flex-wrap items-center justify-center gap-4 p-4 text-xs text-zinc-500">
        <VersionBadge
          version={APP_VERSION}
          build={APP_BUILD}
          onExport={exportLog}
          onProgress={(n) => setNotice(`再点 ${n} 次导出诊断文件`, WINDOW_HINT_MS)}
        />
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
        {/* 提示浮在页脚上方、不参与排版：一出现就挤动页脚的话，连点版本号的手指会点空 */}
        {/* 常驻、只换文字：读屏软件对刚插入的提示区播报不稳定；没有提示时隐藏 */}
        <span
          role="status"
          className={`pointer-events-none absolute inset-x-4 bottom-full mb-1 rounded bg-zinc-800/90 px-3 py-2 text-center text-balance text-zinc-200 ${notice.text === "" ? "invisible" : ""}`}
        >
          {notice.text}
        </span>
      </footer>
      <UpdateDialog controller={pwa} />
    </div>
  );
}
