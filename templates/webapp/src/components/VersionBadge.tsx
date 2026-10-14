/**
 * 版本号标签，兼作诊断导出的暗门：2 秒内连点 5 次触发 onExport。暗门不占界面，用户反馈问题时由
 * 开发者口头告知怎么导出——所以点的过程必须有反馈：从第 3 下起经 onProgress 报还差几下。
 * 点按区比文字大一圈（负外边距抵消，不改版面），touch-action 关掉双击缩放，免得连点时页面放大。
 * 故意不做成按钮、不进键盘焦点：它不是给普通用户的功能入口。
 */
import { useRef } from "react";

const TAPS = 5;
const WINDOW_MS = 2000;
/** 从第几下开始提示剩余次数 */
const HINT_FROM = 3;

export function VersionBadge({
  version,
  build,
  onExport,
  onProgress,
}: {
  version: string;
  build: number;
  onExport: () => void;
  /** remaining = 还差几下 */
  onProgress: (remaining: number) => void;
}) {
  const taps = useRef<number[]>([]);

  const tap = (): void => {
    const now = Date.now();
    taps.current = [...taps.current.filter((t) => now - t < WINDOW_MS), now];
    const count = taps.current.length;
    if (count >= TAPS) {
      taps.current = [];
      onExport();
    } else if (count >= HINT_FROM) {
      onProgress(TAPS - count);
    }
  };

  return (
    <span
      data-testid="app-version"
      data-version={`${version}+${build}`}
      className="-mx-2 -my-3 select-none px-2 py-3"
      style={{ touchAction: "manipulation" }}
      onClick={tap}
    >
      版本 {version.replace(/^v/, "")}（构建 {build}）
    </span>
  );
}
