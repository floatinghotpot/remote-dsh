/**
 * 回归护栏：`cordis.patch.yml` 必须始终把目录选择器钉成 browse。
 *
 * 事实依据：doc/fix/20260917-remote-workspace-picker/（discussion F7/F13、
 * solution T1）。远端浏览器够不到宿主 OS 对话框，所以插件存在的意义就要求
 * `@deepseek-ai/dsh-host-directory-picker-auto` 不被允许解析成 native。
 *
 * 断言是「结构性」的（按缩进切出顶层 patch 条目），不是子串匹配 —— 但刻意
 * 不引入 YAML 依赖：这个文件是我们自己发布的、结构固定的小文件。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const PATCH_PATH = fileURLToPath(new URL("../cordis.patch.yml", import.meta.url));

/** 去掉注释与空行后的有效行。 */
function meaningfulLines(): string[] {
  return readFileSync(PATCH_PATH, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "" && !line.trimStart().startsWith("#"));
}

/** 按顶层 `- ` 切出每个 patch 条目的原文。 */
function topLevelEntries(): string[] {
  const entries: string[] = [];
  for (const line of meaningfulLines()) {
    if (line.startsWith("- ")) entries.push(line);
    else if (entries.length > 0) entries[entries.length - 1] += `\n${line}`;
    else throw new Error(`cordis.patch.yml: 顶层出现非条目行：${line}`);
  }
  return entries;
}

test("cordis.patch.yml：仍挂载本插件（server 行 = client 半的发现标记）", () => {
  const entries = topLevelEntries();
  assert.ok(
    entries.some((e) => e.includes("insert:") && e.includes("id: remote-access") && e.includes("name: 'dsh-web-remote'")),
    "必须保留 remote-access 插入行",
  );
});

test("cordis.patch.yml：禁用 boot 期自适应选择器行", () => {
  const entries = topLevelEntries();
  const disable = entries.filter((e) => e.includes("id: directory-picker") && e.includes("disabled: true"));
  assert.equal(disable.length, 1, "必须恰好有一条 `- id: directory-picker` + `disabled: true`");
  // 该条目不得带 insert/其它字段（保持最小语义）
  assert.ok(!disable[0]!.includes("insert:"), "禁用条目不应包含 insert");
});

test("cordis.patch.yml：插入 browse 后端与浏览器半，且 name 精确匹配", () => {
  const entries = topLevelEntries();
  const pin = entries.find((e) => e.includes("id: directory-picker-browse"));
  assert.ok(pin !== undefined, "缺少 directory-picker-browse 插入行");
  assert.ok(pin!.includes("insert:"), "browse 行必须是 insert 条目");
  assert.ok(
    pin!.includes("name: '@deepseek-ai/dsh-host-directory-picker-browse'"),
    "后端包名必须精确为 @deepseek-ai/dsh-host-directory-picker-browse",
  );
  assert.ok(
    pin!.includes("id: ui-directory-picker-browse") &&
      pin!.includes("name: '@deepseek-ai/dsh-client-ui-directory-picker-browse'"),
    "必须同时插入浏览器半 @deepseek-ai/dsh-client-ui-directory-picker-browse",
  );
  assert.ok(!pin!.includes("directory-picker-native"), "不得插入 native 面（远端浏览器够不到）");
});

test("cordis.patch.yml：不得重复插入同一个 id（重复会让 dsh 启动失败）", () => {
  const ids = meaningfulLines()
    .filter((line) => /^\s*-?\s*id:\s*\S+/.test(line))
    .map((line) => line.replace(/^.*id:\s*/, "").trim());
  const seen = new Set<string>();
  for (const id of ids) {
    assert.ok(!seen.has(id), `重复的 loader 条目 id：${id}（会导致 duplicate loader entry id）`);
    seen.add(id);
  }
  assert.ok(ids.includes("directory-picker-browse") && ids.includes("ui-directory-picker-browse"));
});
