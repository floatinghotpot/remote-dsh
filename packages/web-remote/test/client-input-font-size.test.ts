/**
 * 回归护栏：DSH 插件面板的输入框在窄屏/触屏下必须 ≥16px。
 *
 * 事实依据：iOS（Safari / WKWebView，含微信等 App 内浏览器）对 computed font-size < 16px
 * 的输入框，在聚焦时会自动放大整个页面。面板基础字号是 13px（桌面观感要紧凑），所以
 * 窄屏/触屏必须有一条 16px 覆盖规则 —— 否则在手机上填 Hub 地址 / join token / 访问口令时
 * 整页被放大，操作体验与 portal 登录页遇到的是同一个问题。
 *
 * 断言是「结构性」的：先切出 client.js 里的 CSS 模板字符串，再分别断言媒体规则的条件与
 * 规则体，而不是对整份文件做子串匹配。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const clientJs = readFileSync(fileURLToPath(new URL("../client.js", import.meta.url)), "utf8");

/** client.js 里运行时注入的 `const CSS = \`...\`;` 模板字符串。 */
function pluginCss(src: string): string {
  const m = /const CSS = `([\s\S]*?)`;/.exec(src);
  assert.ok(m, "client.js 里找不到 CSS 模板字符串");
  return m[1] ?? "";
}

/** 面板输入框在非媒体规则里的基础字号（桌面档）。 */
function baseInputFontSize(css: string): number | null {
  const m = /\.dsh-web-remote-field input\{[^}]*font-size:(\d+)px/.exec(css);
  return m?.[1] === undefined ? null : Number(m[1]);
}

test("面板输入框基础字号 < 16px：桌面保持紧凑，字号由窄屏规则接管", () => {
  const size = baseInputFontSize(pluginCss(clientJs));
  assert.notEqual(size, null, "找不到 .dsh-web-remote-field input 的 font-size");
  assert.ok((size ?? 0) < 16, `基础字号应为桌面档（<16px），实际 ${String(size)}px`);
});

test("窄屏/触屏媒体规则把面板内输入控件提到 16px", () => {
  const css = pluginCss(clientJs);
  const rules = [...css.matchAll(/@media([^{]*)\{([\s\S]*?)\n\s*\}/g)];
  const hit = rules.find((r) => /font-size:16px/.test(r[2] ?? ""));
  assert.ok(hit, "缺少把输入框字号提到 16px 的媒体规则");

  const condition = hit[1] ?? "";
  const body = hit[2] ?? "";
  assert.match(condition, /max-width:\s*640px/, "缺少窄屏条件（max-width: 640px）");
  assert.match(condition, /pointer:\s*coarse/, "缺少触屏条件（pointer: coarse，覆盖 iPad/平板）");
  assert.match(body, /\.dsh-web-remote input/, "规则未覆盖面板内的 input（面板根类为 .dsh-web-remote）");
  assert.ok(!/!important/.test(body), "不应依赖 !important：面板输入框没有内联字号");
});
