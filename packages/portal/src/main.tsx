import "./theme.css";
import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./pages.tsx";
import { applyTheme } from "./theme.ts";

// 在首次渲染前落定主题，避免先以默认浅色闪一帧再切深色。
applyTheme();

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
