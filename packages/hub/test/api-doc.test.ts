/**
 * api-doc.test.ts — 对外 API 契约门禁（PROTOCOL-FIRST，见 AGENTS.md §7）。
 *
 * 断言两件事：
 *   1. 代码里声明的 `/api/*` 路由必须写进 `API.md`（或命中下方 INTERNAL_ROUTES 允许清单）；
 *   2. `API.md` 里写的端点必须在实现里存在（防「文档写了、实现没有」）。
 *
 * 允许清单是刻意的摩擦：新增内部/渠道端点必须在这里手动登记并写明理由，
 * 避免「随手加个接口、文档永远不更新」重演 2026-11-04 的契约漂移。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** 不对第三方开放、因此不进 `API.md` 正文的端点。每条都必须写明理由。 */
const INTERNAL_ROUTES: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /^\/api\/nodes\//, reason: "中继节点上行协议，仅节点使用（30-relay-node）" },
  { pattern: /^\/api\/usage\/report$/, reason: "客户端/网关用量上报口（§11 已说明语义）" },
  { pattern: /^\/api\/host\/usage\/report$/, reason: "gateway 以 host token 上报用量（§11）" },
  { pattern: /^\/api\/relay\/usage\/report$/, reason: "relay 转发侧批量上报（§12）" },
  { pattern: /^\/api\/internal\//, reason: "服务令牌内部接口（§14 有概览，字段不对外承诺）" },
  { pattern: /^\/api\/billing\/unicpay\/(prepay|store\/verify|webhook)$/, reason: "支付渠道侧回调/预下单，非客户端调用" },
  { pattern: /^\/api\/admin\/metrics$/, reason: "运维观测口，无 UI 消费方（探活用 /api/admin/health）" },
  { pattern: /^\/api\/events$/, reason: "portal SSE 在线推送（内部）" },
  { pattern: /^\/api\/hosts\/self-revoke$/, reason: "主机持 host token 自注销（`rdsh host leave`）" },
  { pattern: /^\/api\/wechat\//, reason: "网站应用微信 OAuth 流（§9 有概览，页面级跳转不逐条列）" },
];

const normalize = (p: string): string =>
  p
    .replace(/\{[^}]*\}/g, "{id}")
    .replace(/:[a-zA-Z]+/g, "{id}")
    .replace(/\/+$/, "");

/** 把路由正则字面量展开成具体路径（处理 `([^/]+)` 参数、`(?:/x)?` 可选段、`(a|b|c)` 枚举）。 */
function expandRegexLiteral(literal: string): string[] {
  let p = literal.replace(/\\\//g, "/").replace(/^\^/, "").replace(/\$$/, "");
  p = p.replace(/\(\[\^\/\]\+\)/g, "{id}");

  // 可选段：`(?:/{id})?` → 同时产生「不带」与「带」两个分支。
  const opt = /\(\?:\/(\{id\})\)\?/.exec(p);
  if (opt) {
    const without = p.slice(0, opt.index) + p.slice(opt.index + opt[0].length);
    const withSeg = p.slice(0, opt.index) + "/" + opt[1] + p.slice(opt.index + opt[0].length);
    return [...expandRegexLiteral(without), ...expandRegexLiteral(withSeg)];
  }

  // 枚举：`(a|b|c)` → 每个分支。
  const alt = /\(([^()]*(?:\|[^()]*)+)\)/.exec(p);
  if (alt) {
    return alt[1]
      .split("|")
      .flatMap((option) => expandRegexLiteral(p.slice(0, alt.index) + option + p.slice(alt.index! + alt[0].length)));
  }

  return [p.replace(/\([^)]*\)/g, "{id}")];
}

/** 实现里声明的所有 `/api/*` 路径（静态写法 + 正则写法）。 */
function extractCodePaths(): Set<string> {
  const out = new Set<string>();
  for (const file of readdirSync(join(ROOT, "src")).filter((f) => f.endsWith(".ts"))) {
    const source = readFileSync(join(ROOT, "src", file), "utf8");
    for (const m of source.matchAll(/(?:path|pathname)\s*[!=]==?\s*"(\/api\/[^"]+)"/g)) {
      out.add(normalize(m[1]!));
    }
    for (const m of source.matchAll(/\/\^((?:\\\/api)[^\n]*?)\/\.exec\(/g)) {
      for (const p of expandRegexLiteral(m[1]!)) out.add(normalize(p));
    }
  }
  return out;
}

/**
 * `API.md` 里「正式定义的端点」路径——只取 `###` 标题与表格行里出现的 `/api/...`，
 * 正文/章节标题里的顺带提及（如「（/api/admin/*）」）不算契约定义，避免把
 * 一句口头引用当成"已文档化"。
 */
function extractDocPaths(): Set<string> {
  const out = new Set<string>();
  for (const line of readFileSync(join(ROOT, "API.md"), "utf8").split("\n")) {
    if (!line.startsWith("###") && !line.trimStart().startsWith("|")) continue;
    for (const m of line.matchAll(/\/api\/[A-Za-z0-9/{}_.:-]+/g)) {
      const raw = m[0];
      const next = line[m.index! + raw.length];
      if (raw.includes("*") || next === "*") continue; // 概览写法 `/api/admin/*`
      out.add(normalize(raw));
    }
  }
  return out;
}

/** `{id}` 通配为单段。 */
const toPattern = (p: string): RegExp => new RegExp(`^${p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\\{id\\\}/g, "[^/]+")}$`);

test("实现里的 /api 路由都已写进 API.md（或登记为内部端点）", () => {
  const code = extractCodePaths();
  const doc = extractDocPaths();
  const docPatterns = [...doc].map(toPattern);

  // 解析器本身的健全性：静默失效会让门禁变成摆设。
  assert.ok(code.size >= 100, `路由提取数量异常（${code.size}），解析可能已失效`);

  const undocumented = [...code]
    .filter((path) => !docPatterns.some((re) => re.test(path)))
    .filter((path) => !INTERNAL_ROUTES.some((entry) => entry.pattern.test(path)))
    .sort();

  assert.deepEqual(
    undocumented,
    [],
    `以下端点在实现中存在，但既没写进 API.md、也没登记为内部端点：\n  ${undocumented.join("\n  ")}\n\n` +
      `处理方式二选一：写进 API.md，或加入本文件 INTERNAL_ROUTES 并写明理由。`,
  );
});

test("API.md 里写的端点都在实现中存在", () => {
  const code = [...extractCodePaths()];
  const doc = [...extractDocPaths()];

  // 文档里的正式端点必须在实现里存在（防「文档写了、实现没有」）。
  const ghosts = doc
    .filter((path) => !code.some((candidate) => toPattern(path).test(candidate)))
    .sort();

  assert.deepEqual(ghosts, [], `以下端点在 API.md 里有、实现里没有（幽灵契约）：\n  ${ghosts.join("\n  ")}`);
});
