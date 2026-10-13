/**
 * 安装入口与 iOS 图文引导。已安装（独立窗口）时整体不渲染。
 * - iOS 上 Safari 与主屏应用的本地数据是两份，互不相通：有本地数据的应用务必在引导里说清、
 *   并提供导出/导入，且尽量在首次使用早期引导，别等用户攒下数据之后。
 * - 微信/QQ 内置浏览器里没有「添加到主屏幕」，先引导跳到系统浏览器。
 */
import { useInstallPrompt } from "@nexus-kit/pwa-react";
import { APP_VERSION } from "../build-info.ts";

const IOS_STEPS = {
  safari: [
    "点分享按钮（地址栏旁、底部工具栏或「⋯」菜单里那个方框加箭头的图标）",
    "在菜单里选择「添加到主屏幕」",
    "回到桌面，点新出现的图标打开",
  ],
  other: ["点地址栏一侧的分享按钮（方框加箭头的图标）", "在菜单里选择「添加到主屏幕」", "回到桌面，点新出现的图标打开"],
  wechat: ["点右上角「···」，选择「在浏览器打开」", "在打开的 Safari 里点分享按钮，选择「添加到主屏幕」", "回到桌面，点新出现的图标打开"],
  qq: ["点右上角「···」，选择「在浏览器打开」", "在打开的 Safari 里点分享按钮，选择「添加到主屏幕」", "回到桌面，点新出现的图标打开"],
} as const;

export function InstallGuide() {
  const install = useInstallPrompt({ version: APP_VERSION });
  if (!install.canInstall) return null;
  const steps = IOS_STEPS[install.browser ?? "safari"];
  return (
    <>
      <button type="button" className="underline underline-offset-2 active:opacity-70" onClick={() => void install.install()}>
        {install.ios ? "添加到主屏幕" : "安装到桌面"}
      </button>
      {install.iosGuideOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="install-title"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
        >
          <div className="w-full max-w-sm rounded-lg bg-zinc-900 p-5 text-left text-sm text-zinc-200 shadow-xl">
            <h2 id="install-title" className="text-lg font-bold">
              装进主屏幕，全屏使用
            </h2>
            <ol className="mt-3 list-decimal space-y-2 pl-5">
              {steps.map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ol>
            <p className="mt-3 text-xs text-zinc-400">主屏幕上的应用是全新的开始，这里的记录不会自动带过去。</p>
            <button type="button" className="mt-4 w-full rounded bg-amber-500 py-2 font-bold text-black" onClick={install.dismissIosGuide}>
              知道了
            </button>
          </div>
        </div>
      )}
    </>
  );
}
