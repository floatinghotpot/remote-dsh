/**
 * theme.ts — 解析并应用页面主题。
 *
 * 优先级：URL `?theme=`（App 内嵌 WebView 显式传入，值取自 Flutter 已解析的
 * ThemeMode）→ 系统 `prefers-color-scheme`。
 *
 * 为什么不只用 CSS 媒体查询：WebView 里的 prefers-color-scheme 只反映**系统**
 * 主题，而 App 主题是用户可覆盖的应用级状态；用户改过 App 主题后两者就会不一致，
 * 表现为「App 已是浅色、内嵌页仍是深色」。
 */

export type Theme = "light" | "dark";

/** 从 URL 查询串读取显式主题；非 light/dark 一律视为未指定。 */
function themeFromUrl(): Theme | null {
  if (typeof window === "undefined") return null;
  const v = new URLSearchParams(window.location.search).get("theme");
  return v === "light" || v === "dark" ? v : null;
}

/** 系统偏好；不支持 matchMedia 时按浅色。 */
function systemTheme(): Theme {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return "light";
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

/** 当前生效主题：URL 参数优先，其次系统偏好。 */
export function resolveTheme(): Theme {
  return themeFromUrl() ?? systemTheme();
}

/** 把解析结果写入 `<html data-theme>`，供 theme.css 选择变量组。 */
export function applyTheme(): void {
  document.documentElement.dataset.theme = resolveTheme();
}
