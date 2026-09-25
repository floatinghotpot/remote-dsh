import { test } from "node:test";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { RDSH_WEBVIEW_API, injectHtmlScript } from "../src/rdsh-webview-api.ts";

/**
 * 适配脚本的离线夹具测试（req R9 / A3a）：
 * 把 `RDSH_WEBVIEW_API` 放进 node vm + 最小 DOM stub，验证三方法语义、
 * UTF-8 安全 base64 中文往返、非 DSH 页/缺 DOM 的防御式兜底、幂等守卫。
 */

interface El {
  tag: string; // 大写，如 "DIV" / "PRE" / "TEXTAREA"
  attrs: Record<string, string>;
  children: El[];
  text: string; // 自身文本
  parent: El | null;
}

function innerTextOf(n: El): string {
  let out = n.text;
  for (const c of n.children) out += innerTextOf(c);
  return out;
}

/** 属性选择器 + tag 选择器匹配（逗号分隔；属性值 = 精确或存在性匹配）。 */
function matches(n: El, selector: string): boolean {
  return selector.split(",").some((part) => {
    const p = part.trim();
    if (/^[a-z][a-z0-9]*$/i.test(p)) return n.tag.toLowerCase() === p.toLowerCase();
    const conds = p.match(/\[([a-zA-Z-]+)(?:="([^"]*)")?\]/g) ?? [];
    if (conds.length === 0) return false;
    return conds.every((c) => {
      const m = c.match(/\[([a-zA-Z-]+)(?:="([^"]*)")?\]/);
      const name = m![1];
      const value = m![2];
      if (value === undefined) return name in n.attrs;
      return n.attrs[name] === value;
    });
  });
}

function descendants(n: El, out: El[] = []): El[] {
  for (const c of n.children) {
    out.push(c);
    descendants(c, out);
  }
  return out;
}

function clone(n: El, parent: El | null = null): El {
  const c: El = { tag: n.tag, attrs: { ...n.attrs }, children: [], text: n.text, parent };
  c.children = n.children.map((k) => clone(k, c));
  return attach(c);
}

/** 给元素挂上适配脚本用到的方法/getter（el 与 clone 共用，保证克隆节点也有这些能力）。 */
function attach(n: El): El {
  const self = n as El & Record<string, unknown>;
  self.getAttribute = (name: string) => n.attrs[name] ?? null;
  self.hasAttribute = (name: string) => name in n.attrs;
  self.querySelectorAll = (sel: string) => descendants(n).filter((k) => matches(k, sel));
  self.removeChild = (child: El) => {
    const i = n.children.indexOf(child);
    if (i >= 0) n.children.splice(i, 1);
  };
  self.cloneNode = () => clone(n);
  self.focus = () => {};
  self.blur = () => {};
  self.select = () => {};
  self.dispatchEvent = () => true;
  Object.defineProperty(self, "innerText", { get: () => innerTextOf(n), configurable: true });
  Object.defineProperty(self, "textContent", { get: () => innerTextOf(n), configurable: true });
  Object.defineProperty(self, "tagName", { get: () => n.tag, configurable: true });
  return n;
}

function el(tag: string, attrs: Record<string, string> = {}, children: El[] = [], text = ""): El {
  const e: El = { tag: tag.toUpperCase(), attrs, children, text, parent: null };
  for (const c of children) c.parent = e;
  return attach(e);
}

/** 构建可运行适配脚本的 vm 沙箱；返回 window.__rdshWebViewApi。 */
function runAdapter(root: El | null, preSeedApi?: Record<string, unknown>): Record<string, unknown> {
  const window: Record<string, unknown> = {};
  if (preSeedApi !== undefined) window.__rdshWebViewApi = preSeedApi;
  const document = {
    body: root,
    activeElement: null,
    querySelectorAll(sel: string): El[] {
      return root === null ? [] : descendants(root).filter((n) => matches(n, sel));
    },
    querySelector(sel: string): El | null {
      return root === null ? null : (descendants(root).find((n) => matches(n, sel)) ?? null);
    },
    createRange() {
      return { selectNodeContents(): void {} };
    },
    addEventListener(): void {},
    execCommand(): boolean {
      return true;
    },
  };
  window.getSelection = () => ({ removeAllRanges(): void {}, addRange(): void {} });
  window.btoa = (s: string) => Buffer.from(s, "latin1").toString("base64");

  const sandbox: Record<string, unknown> = {
    window,
    document,
    btoa: window.btoa,
    unescape: (s: string) => s.replace(/%([0-9A-Fa-f]{2})/g, (_m, h) => String.fromCharCode(parseInt(h, 16))),
    encodeURIComponent,
    JSON,
    setTimeout: () => 0,
    isNaN,
    parseInt,
    String,
    Array,
    Object,
    InputEvent: class {},
    KeyboardEvent: class {},
    Event: class {},
    HTMLTextAreaElement: { prototype: {} },
    HTMLInputElement: { prototype: {} },
    console,
  };

  runInNewContext(RDSH_WEBVIEW_API, sandbox, { filename: "rdsh-webview-api.js" });
  return (window.__rdshWebViewApi as Record<string, unknown>) ?? {};
}

/** 一个带最后一轮 assistant answer 的 DSH 会话 DOM（含一条用户消息，供 turn/userTurn 断言）。 */
function dshDom(): El {
  return el("BODY", {}, [
    el("DIV", { "data-chat-flow-kind": "assistant-step", "data-chat-group-part": "reasoning", "data-chat-turn": "1" }, [], "思考：不该读"),
    el("DIV", { "data-chat-flow-kind": "assistant-step", "data-chat-group-part": "answer", "data-chat-turn": "1" }, [
      el("DIV", { "data-variant": "think" }, [], "工具卡不该读"),
      el("PRE", {}, [], "代码不该读"),
      el("TABLE", {}, [], "表格不该读"),
      el("SPAN", {}, [], "这是答案正文"),
    ]),
    el("DIV", { "data-chat-flow-kind": "assistant-step", "data-chat-group-part": "answer", "data-chat-turn": "2" }, [
      el("SPAN", {}, [], "最新一轮的答案"),
    ]),
    el("DIV", { "data-chat-flow-kind": "user", "data-chat-turn": "3" }, [], "用户发的新消息"),
    el("DIV", { "data-streaming": "true" }),
  ]);
}

test("isDshPage：DSH 页返回 '1'，非 DSH 页返回 '0'", () => {
  const api = runAdapter(dshDom()) as { isDshPage: () => string };
  assert.equal(api.isDshPage(), "1");
  const plain = runAdapter(el("BODY", {}, [], "普通网页")) as { isDshPage: () => string };
  assert.equal(plain.isDshPage(), "0");
});

test("readReply：DSH 页只读最后一轮答案（排除 reasoning/think/code/table）", () => {
  const api = runAdapter(dshDom()) as { readReply: () => string };
  const json = JSON.parse(Buffer.from(api.readReply(), "base64").toString("utf8"));
  assert.equal(json.dsh, true);
  assert.equal(json.streaming, 1);
  assert.equal(json.text, "最新一轮的答案");
});

test("readReply：非 DSH 页返回整页可见文本", () => {
  const body = el("BODY", {}, [el("P", {}, [], "你好"), el("P", {}, [], "世界")]);
  const api = runAdapter(body) as { readReply: () => string };
  const json = JSON.parse(Buffer.from(api.readReply(), "base64").toString("utf8"));
  assert.equal(json.dsh, false);
  assert.equal(json.text, "你好世界");
});

test("readReply：中文经 UTF-8 安全 base64 往返不坏", () => {
  const body = el("BODY", {}, [], "中文内容，包括 emoji 🚀 和繁体字「國」");
  const api = runAdapter(body) as { readReply: () => string };
  const json = JSON.parse(Buffer.from(api.readReply(), "base64").toString("utf8"));
  assert.equal(json.text, "中文内容，包括 emoji 🚀 和繁体字「國」");
});

test("readReply：返回 turn / userTurn（111：用户发了新消息即可停读）", () => {
  const api = runAdapter(dshDom()) as { readReply: () => string };
  const json = JSON.parse(Buffer.from(api.readReply(), "base64").toString("utf8"));
  assert.equal(json.turn, 2, "turn = 最后一轮答案的 turn");
  assert.equal(json.userTurn, 3, "userTurn = 最大用户 turn");
});

test("readReply：取不到 turn / userTurn 时返回 -1（防御式）", () => {
  // DSH 页但没有任何用户消息：userTurn 取不到。
  const noUser = el("BODY", {}, [
    el("DIV", { "data-chat-flow-kind": "assistant-step", "data-chat-group-part": "answer", "data-chat-turn": "4" }, [], "答案"),
  ]);
  const dsh = runAdapter(noUser) as { readReply: () => string };
  const dshJson = JSON.parse(Buffer.from(dsh.readReply(), "base64").toString("utf8"));
  assert.equal(dshJson.turn, 4);
  assert.equal(dshJson.userTurn, -1);
  // 非 DSH 页：两个都是 -1。
  const plain = runAdapter(el("BODY", {}, [el("P", {}, [], "你好")])) as { readReply: () => string };
  const plainJson = JSON.parse(Buffer.from(plain.readReply(), "base64").toString("utf8"));
  assert.equal(plainJson.turn, -1);
  assert.equal(plainJson.userTurn, -1);
});

test("fillAndSend：有 Lexical composer 返回 'ok'，无 composer 返回 'no-composer'", () => {
  const withComposer = el("BODY", {}, [el("DIV", { "data-lexical-editor": "true" })]);
  assert.equal((runAdapter(withComposer) as { fillAndSend: (t: string) => string }).fillAndSend("hello"), "ok");
  const noComposer = el("BODY", {}, []);
  assert.equal((runAdapter(noComposer) as { fillAndSend: (t: string) => string }).fillAndSend("hello"), "no-composer");
});

test("防御式：缺 DOM 不抛错，readReply 返回空结果", () => {
  const api = runAdapter(null) as { readReply: () => string; isDshPage: () => string };
  assert.equal(api.isDshPage(), "0");
  const json = JSON.parse(Buffer.from(api.readReply(), "base64").toString("utf8"));
  assert.equal(json.dsh, false);
  assert.equal(json.text, "");
});

test("幂等：window.__rdshWebViewApi 已存在时不重复挂载（守卫短路）", () => {
  const sentinel = { version: 1, isDshPage: () => "SENTINEL" };
  const api = runAdapter(dshDom(), sentinel) as { isDshPage: () => string };
  assert.equal(api.isDshPage(), "SENTINEL", "已有契约不得被覆盖");
});

test("injectHtmlScript：插到 </head> 前；无 </head> 则前置", () => {
  assert.equal(
    injectHtmlScript("<html><head></head><body></body></html>", "X"),
    "<html><head><script>X</script></head><body></body></html>",
  );
  assert.equal(injectHtmlScript("<html><body></body></html>", "X"), "<script>X</script><html><body></body></html>");
});
