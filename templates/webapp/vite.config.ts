import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { bootGuardScript } from "@nexus-kit/runtime/boot";
import { nexusPwa } from "@nexus-kit/vite";
import { defineConfig } from "vite";
import { APP_ID, APP_NAME, RUNTIME_PARTITIONS } from "./pwa.config.ts";

export default defineConfig(({ command }) => ({
  server: { host: "0.0.0.0", allowedHosts: true },
  plugins: [
    // 主包加载失败兜底：主包没加载上时 runtime 也没加载上，只能靠注入 <head> 的内联脚本（赶在主包之前执行）。
    // 脚本由 @nexus-kit/runtime/boot 生成，与 runtime 里的「重新加载到最新版」同一份源码；主包一启动
    // （src/observe.ts 调 markBooted）它就退出。开了 CSP 的部署要给这段内联脚本放行（hash 或 nonce）
    {
      name: "nexus-boot-guard",
      transformIndexHtml: () => [
        {
          tag: "script",
          injectTo: "head",
          children: bootGuardScript({
            title: "加载失败",
            hint: "应用没能加载完成，可能是网络不好或正在更新版本。点「重新加载」再试；还不行就关掉页面重新打开（主屏应用从多任务界面划掉；微信里点右上角「···」选「在浏览器打开」）。",
            reload: "重新加载",
            checking: "正在检查新版本…",
            updating: "正在下载新版本…",
          }),
        },
      ],
    },
    react(),
    tailwindcss(),
    nexusPwa({
      command,
      appId: APP_ID,
      root: import.meta.dirname,
      manifest: {
        name: APP_NAME,
        short_name: APP_NAME,
        description: APP_NAME,
        background_color: "#0b0b0f",
        theme_color: "#0b0b0f",
        icons: [
          { src: "icons/icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "icons/icon-512.png", sizes: "512x512", type: "image/png" },
          { src: "icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
      runtimePartitions: RUNTIME_PARTITIONS,
      precache: { includeAssets: ["favicon.png", "apple-touch-icon.png"] },
    }),
  ],
}));
