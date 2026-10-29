/**
 * rdsh-webview-api.ts — 智能体 API 契约适配脚本（注入 DSH 首页，feature 22）。
 *
 * 挂出稳定契约 `window.__rdshWebViewApi`（version 2），供 WebView 客户端（如 the App）优先消费，
 * 以把「DSH 版本适配」从 App（发版慢）挪到 gateway（随 npm 包快速发布）。
 *
 * 契约正文与语义以 App 内部契约文档 R7 为准；
 * 本脚本是 App 的 WebView bridge 的 `_bridgeJs` 的**精简等价物**：
 * - 保留：isDshPage / readReply / fillAndSend 三方法及其 DOM 细节（Lexical 写入管线、
 *   最后一轮答案提取、UTF-8 安全 base64）；
 * - 去掉：`report()` 通道与 105 诊断探针（那是 App 侧独有的 debug 机制）。
 *
 * feature 59：version 升到 2；readReply 增加结构化字段（userText / reasoning /
 * activity / rich / question）；fillAndSend 改用全局标记 `window.__rdshInserting`
 * 放行 App 的焦点门控（交互策略归 App，网关不再自带键盘守卫）。
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
  // 发送后主动收起软键盘（blur + 清选区）。常开的焦点门控由 App 侧注入的
  // __rdshBridge 负责，这里不重复实现（feature 59）。
  function dismissKeyboard() {
    try {
      var active = document.activeElement;
      if (active && active !== document.body && typeof active.blur === 'function') active.blur();
      var selection = window.getSelection();
      if (selection && selection.removeAllRanges) selection.removeAllRanges();
    } catch (e) {}
  }

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
  // ---- feature 59 v2：readReply 的补充提取（简洁模式消费） ----
  function userTextOf() {
    var nodes = document.querySelectorAll('[data-chat-flow-kind="user"]');
    var last = nodes.length ? nodes[nodes.length - 1] : null;
    return userTextOfNode(last);
  }
  // 取用户消息正文，排除操作行（时间 + 复制/分支按钮，都在 [data-clock] 里）。
  function userTextOfNode(node) {
    if (!node) { return ''; }
    try {
      var clone = node.cloneNode(true);
      var actions = clone.querySelectorAll('[data-clock]');
      for (var i = 0; i < actions.length; i++) {
        if (actions[i].parentNode) { actions[i].parentNode.removeChild(actions[i]); }
      }
      return (clone.innerText || clone.textContent || '').replace(/\\s+/g, ' ').trim();
    } catch (e) {
      return (node.innerText || node.textContent || '').replace(/\\s+/g, ' ').trim();
    }
  }
  function reasoningTextOf() {
    var nodes = document.querySelectorAll('[data-chat-group-part="reasoning"]');
    var last = nodes.length ? nodes[nodes.length - 1] : null;
    var t = last
      ? (last.innerText || last.textContent || '').replace(/\\s+/g, ' ').trim()
      : '';
    return t.replace(/^(?:运行中思考|思考)[:：\\s]*/, ''); // 去掉「运行中思考/思考」标题前缀
  }
  function richCounts() {
    var counts = { code: 0, table: 0, file: 0 };
    try {
      var steps = Array.prototype.slice.call(
        document.querySelectorAll('[data-chat-flow-kind="assistant-step"]'));
      var answers = steps.filter(function (el) {
        return el.getAttribute('data-chat-group-part') !== 'reasoning';
      });
      var maxTurn = -1;
      for (var i = 0; i < answers.length; i++) {
        var t = parseInt(answers[i].getAttribute('data-chat-turn'), 10);
        if (!isNaN(t) && t > maxTurn) { maxTurn = t; }
      }
      var parts = answers.filter(function (el) {
        return parseInt(el.getAttribute('data-chat-turn'), 10) === maxTurn;
      });
      for (var j = 0; j < parts.length; j++) {
        counts.code += parts[j].querySelectorAll('pre').length;
        counts.table += parts[j].querySelectorAll('table').length;
      }
      counts.file = document.querySelectorAll('[data-presented-file]').length;
    } catch (e) {}
    return counts;
  }
  function questionCard() {
    try {
      var card = document.querySelector('[data-question-key]');
      if (!card) { return null; }
      return {
        key: card.getAttribute('data-question-key') || '',
        text: (card.innerText || card.textContent || '')
          .replace(/\\s+/g, ' ').trim().slice(0, 300)
      };
    } catch (e) { return null; }
  }
  // 146：最近 10 段最终消息（用户提问 / 智能体回答），按 turn 升序。
  function historyOf() {
    var items = [];
    try {
      var users = document.querySelectorAll('[data-chat-flow-kind="user"]');
      for (var i = 0; i < users.length; i++) {
        var turn = parseInt(users[i].getAttribute('data-chat-turn'), 10);
        var text = userTextOfNode(users[i]);
        if (text) { items.push({ kind: 'user', text: text.slice(0, 400), turn: turn }); }
      }
      var steps = document.querySelectorAll('[data-chat-flow-kind="assistant-step"]');
      var byTurn = {};
      for (var j = 0; j < steps.length; j++) {
        if (steps[j].getAttribute('data-chat-group-part') === 'reasoning') { continue; }
        var turn = parseInt(steps[j].getAttribute('data-chat-turn'), 10);
        var text = answerTextOf(steps[j], true);
        if (text) {
          if (!byTurn[turn]) { byTurn[turn] = []; }
          byTurn[turn].push(text);
        }
      }
      for (var t in byTurn) {
        items.push({
          kind: 'assistant',
          text: byTurn[t].join('\\n\\n').slice(0, 1000),
          turn: parseInt(t, 10)
        });
      }
      items.sort(function (a, b) { return a.turn - b.turn; });
    } catch (e) {}
    return items.slice(-10);
  }
  function activityOf(answerTurn, userTurn) {
    var act = { kind: 'idle', label: '', detail: '' };
    try {
      // 思考优先：reasoning 正在运行（data-state="running"）即 thinking。
      // 不依赖 answerTurn —— 思考阶段 DSH 可能已渲染空的 response 占位，导致
      // answerTurn == userTurn，若按 streaming 判会把思考误判成「正在输出」。
      var running = document.querySelectorAll(
        '[data-variant="think"][data-state="running"]');
      if (running.length > 0) {
        var lastReas = running[running.length - 1];
        var t = (lastReas.innerText || lastReas.textContent || '')
          .replace(/\\s+/g, ' ').trim();
        act.kind = 'thinking';
        act.detail = t.replace(/^(?:运行中思考|思考)[:：\\s]*/, '');
        return act;
      }
      // 执行：本轮尚无回答，且 DOM 顺序最新是 tool-call → tool。
      if (userTurn > answerTurn) {
        var tools = document.querySelectorAll('[data-chat-flow-kind="tool-call"]');
        var lastTool = tools.length ? tools[tools.length - 1] : null;
        if (lastTool) {
          act.kind = 'tool';
          act.label = (lastTool.innerText || lastTool.textContent || '')
            .replace(/\\s+/g, ' ').trim().slice(0, 80);
        }
        return act; // 无 tool-call → 用户刚发言、智能体还没开始（146 用 waiting 覆盖）
      }
      // 本轮已有回答：response 在流式 → writing，否则 idle。
      if (document.querySelectorAll('[data-streaming]').length > 0) {
        act.kind = 'writing';
      }
    } catch (e) {}
    return act;
  }

  window.__rdshWebViewApi = {
    version: 2,
    // 104：写入 composer 并提交。返回裸状态 token。
    // 用全局标记 window.__rdshInserting 放行 App 的焦点门控（feature 59）。
    fillAndSend: function (text) {
      var found = findComposer();
      if (!found) return 'no-composer';
      window.__rdshInserting = true;
      if (!insertText(found.el, text)) {
        window.__rdshInserting = false;
        return 'fill-failed';
      }
      window.__rdshInserting = false;
      dismissKeyboard();
      setTimeout(function () { pressEnter(found.el); dismissKeyboard(); }, 80);
      return 'ok';
    },
    // 105/111：待朗读内容 + 状态；59 v2 增加结构化字段。
    // 返回 UTF-8 安全的 base64 JSON。
    readReply: function () {
      var out = {
        dsh: false, streaming: 0, text: '', turn: -1, userTurn: -1,
        userText: '', reasoning: '',
        activity: { kind: 'idle', label: '', detail: '' },
        rich: { code: 0, table: 0, file: 0 },
        question: null,
        history: []
      };
      try {
        out.streaming = document.querySelectorAll('[data-streaming]').length;
        if (document.querySelectorAll('[data-chat-flow-kind]').length > 0) {
          out.dsh = true;
          var answer = latestAnswer();
          out.text = answer.text;
          out.turn = answer.turn;
          out.userTurn = maxTurnOf('user');
          out.userText = userTextOf();
          out.reasoning = reasoningTextOf();
          out.rich = richCounts();
          out.activity = activityOf(answer.turn, out.userTurn);
          out.question = questionCard();
          out.history = historyOf();
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
    },
    // 59：打断智能体生成 —— 点击 composer 主按钮（生成中其 aria-label 变为
    // 「停止生成」/「Stop generating」）。返回 ok / no-stop。
    stopGeneration: function () {
      try {
        var btns = document.querySelectorAll('button[aria-label]');
        for (var i = 0; i < btns.length; i++) {
          var label = btns[i].getAttribute('aria-label');
          if (label === '停止生成' || label === 'Stop generating') {
            btns[i].click();
            return 'ok';
          }
        }
        return 'no-stop';
      } catch (e) { return 'no-stop'; }
    }
  };
})();`;

/** 把 `<script>${script}</script>` 插到 `</head>` 前（无则前置）；纯函数，可单测。 */
export function injectHtmlScript(html: string, script: string): string {
  const tag = `<script>${script}</script>`;
  if (html.includes("</head>")) return html.replace("</head>", `${tag}</head>`);
  return `${tag}${html}`;
}
