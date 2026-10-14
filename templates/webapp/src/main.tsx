// 日志、取证与白屏兜底最先初始化：之后入口代码抛错、动态导入失败、界面渲染崩溃都会被兜住
// （静态导入的模块本身加载失败时整个模块图都不执行，兜不住）
import { crashFallback } from "./observe.ts";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app.tsx";
import { ErrorBoundary } from "./components/ErrorBoundary.tsx";
import "./index.css";
import { pwa } from "./pwa.ts";

const root = document.getElementById("root");
if (root === null) throw new Error("index.html 缺 #root");
createRoot(root).render(
  <StrictMode>
    <ErrorBoundary onCrash={crashFallback.report} onMounted={crashFallback.markMounted}>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
pwa.startWhenIdle();
