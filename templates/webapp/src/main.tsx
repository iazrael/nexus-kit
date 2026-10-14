// 日志与取证最先初始化：取证要在渲染之前写下本局的开启标记
import "./observe.ts";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app.tsx";
import "./index.css";
import { pwa } from "./pwa.ts";

const root = document.getElementById("root");
if (root === null) throw new Error("index.html 缺 #root");
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
pwa.startWhenIdle();
