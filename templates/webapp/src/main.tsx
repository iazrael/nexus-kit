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
