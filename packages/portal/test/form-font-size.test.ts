/**
 * form-font-size.test.ts — 守卫：表单控件字号必须由 theme.css 声明（桌面 14px / 窄屏 16px）。
 *
 * 为什么需要这个测例：iOS（Safari / WKWebView，含微信等 App 内浏览器）对 computed
 * font-size < 16px 的输入框，在聚焦时会自动放大整个页面；而 CSS 媒体查询压不过内联
 * 样式，一旦有人在表单控件上重新写回内联 `fontSize: 14`，窄屏 16px 规则会**静默失效**
 * （用户只看到"点输入框页面变大"，CI 不会红）。这里把该约束钉死。
 *
 * 已知不覆盖（如需延伸请单独加测例）：
 *   - 本测例只管 portal；其它包的表单控件各有自己的守卫测例
 *     （如 web-remote 的 client-input-font-size.test.ts）；
 *   - 触屏笔记本（pointer: coarse 且宽度 > 640px）会按触屏档取 16px，属有意为之。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/** 内联小字号：阈值为 16px，10–15px 都会触发 iOS 聚焦自动放大。 */
const SMALL_FONT = /fontSize:\s*1[0-5]\b/;
/** 表单控件标签（checkbox/radio 的渲染尺寸与字号无关，故只需排除其样式值而非标签）。 */
const CONTROL_TAG = /^(input|select|textarea)$/;

const readSrc = (rel: string): string => readFileSync(fileURLToPath(new URL(`../src/${rel}`, import.meta.url)), "utf8");

/** 抠出设定 16px 表单字号的那条媒体规则（按内容找，文件里还有 `prefers-color-scheme: dark` 块）。 */
function mobileFormRule(css: string): { condition: string; body: string } | null {
  for (const m of css.matchAll(/@media([^{]*)\{([\s\S]*?)\n\}/g)) {
    const body = m[2] ?? "";
    if (/font-size:\s*16px/.test(body)) return { condition: m[1] ?? "", body };
  }
  return null;
}

/**
 * 按 `style={{ ... }}` 切出样式块：先把源码压成单行，跨行书写的样式对象也能整体检查。
 * 值里没有嵌套对象（都是字面量 / `var(--x)`），故 `[^{}]` 足够；宿主元素取块前最近的开始标签。
 */
function styleBlocks(src: string): { body: string; tag: string }[] {
  const flat = src.replace(/\s+/g, " ");
  return [...flat.matchAll(/style=\{\{([^{}]*)\}\}/g)].map((m) => {
    const before = flat.slice(0, m.index ?? 0);
    let tag = "";
    for (const t of before.matchAll(/<([a-zA-Z][a-zA-Z0-9]*)/g)) tag = t[1] ?? "";
    return { body: m[1] ?? "", tag: tag.toLowerCase() };
  });
}

describe("portal 表单控件字号（iOS 聚焦自动放大防护）", () => {
  it("theme.css 声明了桌面基线字号", () => {
    expect(readSrc("theme.css")).toMatch(/font-size:\s*14px/);
  });

  it("theme.css 在窄屏/触屏下把 input/select/textarea 提到 16px", () => {
    const rule = mobileFormRule(readSrc("theme.css"));
    expect(rule, "找不到设定 16px 表单字号的媒体规则").not.toBeNull();
    // 触屏条件必须与窄屏条件并存：iPad 竖屏 768px / 横屏 1024px，只看宽度会漏
    expect(rule?.condition).toContain("max-width: 640px");
    expect(rule?.condition).toContain("pointer: coarse");
    for (const sel of ["input", "select", "textarea"]) {
      expect(rule?.body, `窄屏规则缺少 ${sel}`).toContain(sel);
    }
  });

  it("窄屏规则不依赖 !important（内联字号已清除，无需强压）", () => {
    expect(mobileFormRule(readSrc("theme.css"))?.body ?? "").not.toContain("!important");
  });

  it("pages.tsx 不在表单控件上内联 < 16px 字号（否则会压过媒体查询）", () => {
    const src = readSrc("pages.tsx");

    // ① 逐行：覆盖"声明一次、到处共用"的样式对象（如 inputStyle() 的 return 语句）
    const perLine = src
      .split("\n")
      .map((line, no) => ({ line, no: no + 1 }))
      .filter(({ line }) => /boxSizing:\s*"border-box"/.test(line) && SMALL_FONT.test(line))
      .map(({ no }) => `pages.tsx:${no}`);

    // ② 按样式块：跨行的 style={{...}} 也能识别，并按宿主标签判定是否为表单控件
    //    （覆盖不带 boxSizing 的控件，例如只写 padding 的 select）
    const perBlock = styleBlocks(src)
      .filter((b) => SMALL_FONT.test(b.body) && (CONTROL_TAG.test(b.tag) || /boxSizing:\s*"border-box"/.test(b.body)))
      .map((b) => `<${b.tag}> ${b.body.trim().slice(0, 60)}`);

    expect([...perLine, ...perBlock]).toEqual([]);
  });
});
