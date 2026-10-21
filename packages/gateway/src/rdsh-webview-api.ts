/**
 * rdsh-webview-api.ts — 智能体 API 契约适配脚本（注入 DSH 首页，feature 22）。
 *
 * 挂出稳定契约 `window.__rdshWebViewApi`（version 1），供 WebView 客户端（如 garsync App）优先消费，
 * 以把「DSH 版本适配」从 App（发版慢）挪到 gateway（随 npm 包快速发布）。
 *
 * 契约正文与语义以 garsync `doc/feature/108_agent_api_contract/req.md` R7 为准；
 * 本脚本是 garsync `lib/rdsh/rdsh_web_bridge.dart` 的 `_bridgeJs` 的**精简等价物**：
 * - 保留：isDshPage / readReply / fillAndSend 三方法及其 DOM 细节（Lexical 写入管线、
 *   键盘守卫、最后一轮答案提取、UTF-8 安全 base64）；
 * - 去掉：`report()` 通道与 105 诊断探针（那是 App 侧独有的 debug 机制）。
 *
 * 安全约定：幂等（已注入即返回）、防御式（任何 DOM 缺失/异常返回安全默认值、绝不抛错）。
 */

export const RDSH_WEBVIEW_API = `(function () {
  if (window.__rdshWebViewApi) return;
  function findComposer() {
    var el = document.querySelector('[data-lexical-editor="true"]');
    if (el) return { el: el, kind: 'lexical' };
    el = document.querySelector('[contenteditable="true"]');
    if (el) return { el: el, kind: 'contenteditable' };
    el = document.querySelector('textarea');
    if (el) return { el: el, kind: 'textarea' };
    return null;
  }
  function selectAll(el) {
    var tag = el.tagName;
    if (tag === 'TEXTAREA' || tag === 'INPUT') { el.select(); return; }
    var range = document.createRange();
    range.selectNodeContents(el);
    var sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }
  function insertText(el, text) {
    el.focus();
    try { selectAll(el); } catch (e) {}
    // 1) execCommand 走浏览器编辑管线，让 Lexical 收到 input 事件。
    try { if (document.execCommand('insertText', false, text)) return true; } catch (e) {}
    // 2) 显式 beforeinput。
    try {
      el.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertText', data: text, bubbles: true, cancelable: true }));
      return true;
    } catch (e) {}
    // 3) 兜底：直接写 DOM + 触发 input。
    try {
      var tag = el.tagName;
      if (tag === 'TEXTAREA' || tag === 'INPUT') {
        var proto = tag === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, text);
      } else {
        el.textContent = text;
      }
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    } catch (e) {}
    return false;
  }
  function pressEnter(el) {
    var opts = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true, composed: true, isComposing: false };
    try {
      el.dispatchEvent(new KeyboardEvent('keydown', opts));
      el.dispatchEvent(new KeyboardEvent('keypress', opts));
      el.dispatchEvent(new KeyboardEvent('keyup', opts));
    } catch (e) {}
  }
  // 键盘守卫：语音写入后关软键盘；用户真实触摸页面即解除。
  var keyboardGuard = false;
  function dismissKeyboard() {
    try {
      var active = document.activeElement;
      if (active && active !== document.body && typeof active.blur === 'function') active.blur();
      var selection = window.getSelection();
      if (selection && selection.removeAllRanges) selection.removeAllRanges();
    } catch (e) {}
  }
  function onUserTouch() { if (keyboardGuard) keyboardGuard = false; }
  document.addEventListener('focusin', function () { if (!keyboardGuard) return; dismissKeyboard(); }, true);
  document.addEventListener('pointerdown', onUserTouch, true);
  document.addEventListener('touchstart', onUserTouch, true);

  // 单个 flow 节点的可见文本；proseOnly 额外丢弃整块代码与表格（105 只读答案正文）。
  function answerTextOf(el, proseOnly) {
    var clone = el.cloneNode(true);
    var selector = '[data-variant="think"],[data-variant="others"]';
    if (proseOnly) selector += ',pre,table';
    var drop = clone.querySelectorAll(selector);
    for (var i = 0; i < drop.length; i++) { if (drop[i].parentNode) drop[i].parentNode.removeChild(drop[i]); }
    return (clone.innerText || clone.textContent || '').trim();
  }
  // 某个 flow kind 的最大 turn（取不到 = -1）。
  // 111：App 用 turn / userTurn 判断"用户是否发了新消息"，从而立即停止朗读。
  function maxTurnOf(kind) {
    var nodes = document.querySelectorAll('[data-chat-flow-kind="' + kind + '"]');
    var max = -1;
    for (var i = 0; i < nodes.length; i++) {
      var t = parseInt(nodes[i].getAttribute('data-chat-turn'), 10);
      if (!isNaN(t) && t > max) max = t;
    }
    return max;
  }
  // 最后一轮的答案部分（排除 reasoning，取最大 turn，逐 part 拼接）。
  // 返回 { text, turn }：turn 与该轮答案对应，供 readReply 回带给 App。
  function latestAnswer() {
    var steps = Array.prototype.slice.call(document.querySelectorAll('[data-chat-flow-kind="assistant-step"]'));
    var answers = steps.filter(function (el) { return el.getAttribute('data-chat-group-part') !== 'reasoning'; });
    var maxTurn = -1;
    for (var i = 0; i < answers.length; i++) {
      var turn = parseInt(answers[i].getAttribute('data-chat-turn'), 10);
      if (!isNaN(turn) && turn > maxTurn) maxTurn = turn;
    }
    var parts = answers.filter(function (el) { return parseInt(el.getAttribute('data-chat-turn'), 10) === maxTurn; });
    var texts = [];
    for (var j = 0; j < parts.length; j++) {
      var text = answerTextOf(parts[j], true);
      if (text.length) texts.push(text);
    }
    return { text: texts.join('\\n\\n'), turn: maxTurn };
  }

  window.__rdshWebViewApi = {
    version: 1,
    // 104：写入 composer 并提交。返回裸状态 token。
    fillAndSend: function (text) {
      var found = findComposer();
      if (!found) return 'no-composer';
      keyboardGuard = false;
      if (!insertText(found.el, text)) return 'fill-failed';
      keyboardGuard = true;
      dismissKeyboard();
      setTimeout(function () { pressEnter(found.el); dismissKeyboard(); }, 80);
      return 'ok';
    },
    // 105/111：待朗读内容 + 状态。返回 UTF-8 安全的 base64 JSON
    // {dsh, streaming, text, turn, userTurn}（turn / userTurn 取不到时为 -1）。
    readReply: function () {
      var out = { dsh: false, streaming: 0, text: '', turn: -1, userTurn: -1 };
      try {
        out.streaming = document.querySelectorAll('[data-streaming]').length;
        if (document.querySelectorAll('[data-chat-flow-kind]').length > 0) {
          out.dsh = true;
          var answer = latestAnswer();
          out.text = answer.text;
          out.turn = answer.turn;
          out.userTurn = maxTurnOf('user');
        } else {
          out.text = document.body ? document.body.innerText : '';
        }
      } catch (e) {}
      return window.btoa(unescape(encodeURIComponent(JSON.stringify(out))));
    },
    // 107：是否 DSH 会话页（轻量判定，可轮询）。返回裸 '1' / '0'。
    isDshPage: function () {
      try {
        return document.querySelectorAll('[data-chat-flow-kind]').length > 0 ? '1' : '0';
      } catch (e) { return '0'; }
    }
  };
})();`;

/** 把 `<script>${script}</script>` 插到 `</head>` 前（无则前置）；纯函数，可单测。 */
export function injectHtmlScript(html: string, script: string): string {
  const tag = `<script>${script}</script>`;
  if (html.includes("</head>")) return html.replace("</head>", `${tag}</head>`);
  return `${tag}${html}`;
}
