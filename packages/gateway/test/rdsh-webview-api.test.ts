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
  self.click = () => {};
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

test("feature 59：version 升到 2", () => {
  const api = runAdapter(dshDom()) as { version: number };
  assert.equal(api.version, 2);
});

test("feature 59：readReply 返回 v2 结构化字段", () => {
  const api = runAdapter(dshDom()) as { readReply: () => string };
  const json = JSON.parse(Buffer.from(api.readReply(), "base64").toString("utf8"));
  assert.equal(json.userText, "用户发的新消息");
  assert.equal(json.reasoning, "不该读", "去掉「思考」前缀");
  // 历史 reasoning 无 data-state="running"，不会误判为 thinking；
  // 用户刚发言、无 tool-call → idle（146 层用 userTurn>turn 的 waiting 覆盖）。
  assert.equal(json.activity.kind, "idle");
  assert.deepEqual(json.rich, { code: 0, table: 0, file: 0 }, "最新 turn 无富内容");
  assert.equal(json.question, null);
});

test("feature 59：fillAndSend 走全局标记 __rdshInserting，不再自带键盘守卫", () => {
  assert.ok(RDSH_WEBVIEW_API.includes("__rdshInserting"), "改用全局标记放行 App 焦点门控");
  assert.ok(!RDSH_WEBVIEW_API.includes("keyboardGuard"), "网关不再内置键盘守卫");
});

test("feature 59：activity 在多轮对话中按当前轮判定（回归 P0）", () => {
  // 有历史答案（turn 1）+ 新一轮用户消息（turn 2）+ 当前轮思考、尚无答案 → thinking。
  const thinking = el("BODY", {}, [
    el("DIV", { "data-chat-flow-kind": "assistant-step", "data-chat-group-part": "answer", "data-chat-turn": "1" }, [], "上一轮答案"),
    el("DIV", { "data-chat-flow-kind": "user", "data-chat-turn": "2" }, [], "新问题"),
    el("DIV", { "data-chat-flow-kind": "assistant-step", "data-chat-group-part": "reasoning", "data-chat-turn": "2" }, [
      el("DIV", { "data-variant": "think", "data-state": "running" }, [], "思考：这一轮怎么答"),
    ]),
  ]);
  const thinkingJson = JSON.parse(Buffer.from((runAdapter(thinking) as { readReply: () => string }).readReply(), "base64").toString("utf8"));
  assert.equal(thinkingJson.activity.kind, "thinking", "有历史答案仍应报 thinking 而非 idle");
  assert.equal(thinkingJson.activity.detail, "这一轮怎么答", "detail 去掉「思考」前缀");

  // 当前轮 tool-call → tool。
  const tool = el("BODY", {}, [
    el("DIV", { "data-chat-flow-kind": "assistant-step", "data-chat-group-part": "answer", "data-chat-turn": "1" }, [], "上一轮答案"),
    el("DIV", { "data-chat-flow-kind": "user", "data-chat-turn": "2" }, [], "新问题"),
    el("DIV", { "data-chat-flow-kind": "tool-call", "data-chat-turn": "2" }, [], "读取 /tmp/x.md"),
  ]);
  const toolJson = JSON.parse(Buffer.from((runAdapter(tool) as { readReply: () => string }).readReply(), "base64").toString("utf8"));
  assert.equal(toolJson.activity.kind, "tool");
  assert.equal(toolJson.activity.label, "读取 /tmp/x.md");
});

test("feature 59：已出答案后仍在执行命令 → tool（不依赖 userTurn > turn）", () => {
  // 已有答案（turn 2）+ 用户消息（turn 2）+ 正在运行的命令卡（data-state="running"）→ tool。
  const running = el("BODY", {}, [
    el("DIV", { "data-chat-flow-kind": "assistant-step", "data-chat-group-part": "answer", "data-chat-turn": "2" }, [], "已出的部分答案"),
    el("DIV", { "data-chat-flow-kind": "user", "data-chat-turn": "2" }, [], "问题"),
    el("DIV", { "data-chat-flow-kind": "tool-call", "data-chat-turn": "2" }, [
      el("DIV", { "data-variant": "others", "data-state": "running" }, [], "bash: 执行命令"),
    ]),
  ]);
  const json = JSON.parse(Buffer.from((runAdapter(running) as { readReply: () => string }).readReply(), "base64").toString("utf8"));
  assert.equal(json.activity.kind, "tool", "已出答案仍应报 tool 而非 idle");
  assert.equal(json.activity.label, "bash: 执行命令");
});

test("feature 59：深度求索中标记（data-chat-running）→ tool（不挑工具类型）", () => {
  // 已有答案 + 用户消息 + 深度求索中标记（无 data-holding）→ tool，
  // 覆盖编辑/读取/写入等不打 data-state 的工作态。
  const working = el("BODY", {}, [
    el("DIV", { "data-chat-flow-kind": "assistant-step", "data-chat-group-part": "answer", "data-chat-turn": "2" }, [], "已出的部分答案"),
    el("DIV", { "data-chat-flow-kind": "user", "data-chat-turn": "2" }, [], "问题"),
    el("DIV", { "data-chat-running": "" }, [], "深度求索中"),
  ]);
  const json = JSON.parse(Buffer.from((runAdapter(working) as { readReply: () => string }).readReply(), "base64").toString("utf8"));
  assert.equal(json.activity.kind, "tool", "深度求索中应报 tool 而非 idle");
});

test("feature 59：深度求索中标记带 data-holding → 不报 tool（turn 已停）", () => {
  const holding = el("BODY", {}, [
    el("DIV", { "data-chat-flow-kind": "assistant-step", "data-chat-group-part": "answer", "data-chat-turn": "2" }, [], "已出的答案"),
    el("DIV", { "data-chat-flow-kind": "user", "data-chat-turn": "2" }, [], "问题"),
    el("DIV", { "data-chat-running": "", "data-holding": "" }, [], "深度求索中"),
  ]);
  const json = JSON.parse(Buffer.from((runAdapter(holding) as { readReply: () => string }).readReply(), "base64").toString("utf8"));
  assert.equal(json.activity.kind, "idle", "带 data-holding 的标记不应报 tool");
});

test("feature 59：data-process-activity 细分工具类别（working 时 edit/commands）", () => {
  const editing = el("BODY", {}, [
    el("DIV", { "data-chat-flow-kind": "assistant-step", "data-chat-group-part": "answer", "data-chat-turn": "2" }, [], "已出的部分答案"),
    el("DIV", { "data-chat-flow-kind": "user", "data-chat-turn": "2" }, [], "问题"),
    el("DIV", { "data-chat-running": "" }, [], "深度求索中"),
    el("BUTTON", { "data-process-activity": "edit" }, [], "正在编辑文件 · /tmp/x.md"),
  ]);
  const editJson = JSON.parse(Buffer.from((runAdapter(editing) as { readReply: () => string }).readReply(), "base64").toString("utf8"));
  assert.equal(editJson.activity.kind, "edit", "data-process-activity=edit 应报 edit");
  assert.equal(editJson.activity.label, "/tmp/x.md", "按「 · 」切出 detail 作为 label");

  const commanding = el("BODY", {}, [
    el("DIV", { "data-chat-flow-kind": "assistant-step", "data-chat-group-part": "answer", "data-chat-turn": "2" }, [], "已出的部分答案"),
    el("DIV", { "data-chat-flow-kind": "user", "data-chat-turn": "2" }, [], "问题"),
    el("DIV", { "data-chat-running": "" }, [], "深度求索中"),
    el("BUTTON", { "data-process-activity": "commands" }, [], "正在运行命令 · bash ls -la"),
  ]);
  const cmdJson = JSON.parse(Buffer.from((runAdapter(commanding) as { readReply: () => string }).readReply(), "base64").toString("utf8"));
  assert.equal(cmdJson.activity.kind, "commands", "data-process-activity=commands 应报 commands");
  assert.equal(cmdJson.activity.label, "bash ls -la", "命令 detail 应作为 label");
});

test("feature 59：data-process-activity 细分 tools/subagents/plan/questions", () => {
  const cases: Array<[string, string, string]> = [
    ["tools", "tools", "正在调用工具 · read_file"],
    ["subagents", "subagents", "协调子智能体 · 审查代码"],
    ["plan", "plan", "更新计划 · 3 项任务"],
    ["questions", "questions", "等待操作 · 是否继续"],
  ];
  for (const [attr, kind, text] of cases) {
    const body = el("BODY", {}, [
      el("DIV", { "data-chat-flow-kind": "assistant-step", "data-chat-group-part": "answer", "data-chat-turn": "2" }, [], "已出的部分答案"),
      el("DIV", { "data-chat-flow-kind": "user", "data-chat-turn": "2" }, [], "问题"),
      el("DIV", { "data-chat-running": "" }, [], "深度求索中"),
      el("BUTTON", { "data-process-activity": attr }, [], text),
    ]);
    const json = JSON.parse(Buffer.from((runAdapter(body) as { readReply: () => string }).readReply(), "base64").toString("utf8"));
    assert.equal(json.activity.kind, kind, `data-process-activity=${attr} 应报 ${kind}`);
  }
});

test("feature 59：data-process-activity 无 data-chat-running（已关闭分组）→ idle", () => {
  const closed = el("BODY", {}, [
    el("DIV", { "data-chat-flow-kind": "assistant-step", "data-chat-group-part": "answer", "data-chat-turn": "2" }, [], "已完成的答案"),
    el("DIV", { "data-chat-flow-kind": "user", "data-chat-turn": "2" }, [], "问题"),
    el("BUTTON", { "data-process-activity": "edit" }, [], "修改了文件"),
  ]);
  const json = JSON.parse(Buffer.from((runAdapter(closed) as { readReply: () => string }).readReply(), "base64").toString("utf8"));
  assert.equal(json.activity.kind, "idle", "无 data-chat-running 的 data-process-activity 不应报 edit");
});

test("feature 59：本轮已有回答且 streaming → writing", () => {
  const writing = el("BODY", {}, [
    el("DIV", { "data-chat-flow-kind": "assistant-step", "data-chat-group-part": "answer", "data-chat-turn": "2" }, [], "正在生成的回答"),
    el("DIV", { "data-chat-flow-kind": "user", "data-chat-turn": "2" }, [], "问题"),
    el("DIV", { "data-streaming": "true" }),
  ]);
  const json = JSON.parse(Buffer.from((runAdapter(writing) as { readReply: () => string }).readReply(), "base64").toString("utf8"));
  assert.equal(json.activity.kind, "writing", "本轮已有回答 + streaming → writing");
});

test("feature 59：stopGeneration 点击停止按钮", () => {
  const withStop = el("BODY", {}, [
    el("BUTTON", { "aria-label": "发送" }),
    el("BUTTON", { "aria-label": "停止生成" }),
  ]);
  const api = runAdapter(withStop) as { stopGeneration: () => string };
  assert.equal(api.stopGeneration(), "ok");
  const noStop = runAdapter(el("BODY", {}, [el("BUTTON", { "aria-label": "发送" })])) as { stopGeneration: () => string };
  assert.equal(noStop.stopGeneration(), "no-stop");
});

test("feature 59：readReply 返回最近 10 段 history", () => {
  const dom = el("BODY", {}, [
    el("DIV", { "data-chat-flow-kind": "user", "data-chat-turn": "1" }, [], "第一问"),
    el("DIV", { "data-chat-flow-kind": "assistant-step", "data-chat-group-part": "reasoning", "data-chat-turn": "1" }, [], "思考：不该进 history"),
    el("DIV", { "data-chat-flow-kind": "assistant-step", "data-chat-group-part": "answer", "data-chat-turn": "1" }, [], "第一答"),
    el("DIV", { "data-chat-flow-kind": "user", "data-chat-turn": "2" }, [], "第二问"),
    el("DIV", { "data-chat-flow-kind": "assistant-step", "data-chat-group-part": "answer", "data-chat-turn": "2" }, [], "第二答"),
    el("DIV", { "data-chat-flow-kind": "user", "data-chat-turn": "3" }, [], "第三问"),
    el("DIV", { "data-chat-flow-kind": "assistant-step", "data-chat-group-part": "answer", "data-chat-turn": "3" }, [], "第三答"),
  ]);
  const json = JSON.parse(Buffer.from((runAdapter(dom) as { readReply: () => string }).readReply(), "base64").toString("utf8"));
  // 共 6 段最终消息，不足 10 段时全量返回（同一 turn 内 user 在前、assistant 在后）。
  assert.equal(json.history.length, 6, "不足 10 段全量返回");
  assert.equal(json.history[0].kind, "user");
  assert.equal(json.history[0].text, "第一问");
  assert.equal(json.history[1].kind, "assistant");
  assert.equal(json.history[1].text, "第一答");
  assert.equal(json.history[2].kind, "user");
  assert.equal(json.history[2].text, "第二问");
  assert.equal(json.history[3].kind, "assistant");
  assert.equal(json.history[3].text, "第二答");
  assert.equal(json.history[4].kind, "user");
  assert.equal(json.history[4].text, "第三问");
  assert.equal(json.history[5].kind, "assistant");
  assert.equal(json.history[5].text, "第三答");
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
