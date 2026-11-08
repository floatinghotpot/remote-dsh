/**
 * 只读诊断单测：`pickerDiagnostics` 必须如实反映当前目录选择器形态。
 *
 * 背景（the internal fix record）：插件把选择器钉成 `browse`；
 * 一旦解析结果不是 browse，远端浏览器就只会看到宿主屏幕上的原生对话框，
 * 面板必须能显示出来 —— 这是"上游判定变更 / 有第二个 pin 通道"的唯一可见信号。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pickerDiagnostics } from "../src/index.ts";

/** 构造只实现 `get` 的最小 ctx。 */
function ctxWith(service: unknown): { get(name: string): unknown } {
  return { get: (name: string) => (name === "directoryPicker" ? service : undefined) };
}

test("pickerDiagnostics：browse 能力 → ok", () => {
  const d = pickerDiagnostics(ctxWith({ capability: () => ({ kind: "browse" }) }));
  assert.deepEqual(d, { pickerKind: "browse", expectedPickerKind: "browse", pickerOk: true });
});

test("pickerDiagnostics：native 能力 → 不 ok（远端不可用的信号）", () => {
  const d = pickerDiagnostics(ctxWith({ capability: () => ({ kind: "native" }) }));
  assert.equal(d.pickerKind, "native");
  assert.equal(d.pickerOk, false);
});

test("pickerDiagnostics：服务缺席 → none（不是 ok，也不抛）", () => {
  const d = pickerDiagnostics(ctxWith(undefined));
  assert.equal(d.pickerKind, "none");
  assert.equal(d.pickerOk, false);
});

test("pickerDiagnostics：capability 抛错 → unknown（不让诊断拖垮 RPC）", () => {
  const d = pickerDiagnostics(
    ctxWith({
      capability: () => {
        throw new Error("boom");
      },
    }),
  );
  assert.equal(d.pickerKind, "unknown");
  assert.equal(d.pickerOk, false);
});

test("pickerDiagnostics：能力对象没有 capability() → none", () => {
  const d = pickerDiagnostics(ctxWith({}));
  assert.equal(d.pickerKind, "none");
  assert.equal(d.pickerOk, false);
});

test("面板文案：native 提示必须指向「重启 DSH」这个可执行动作", () => {
  // 回归护栏：刚装/升级插件时 boot 期已挂上的 native 无法被热补丁替换，
  // 用户唯一能做的动作是重启；提示丢掉这句话就等于只报错不给出路。
  const client = readFileSync(new URL("../client.js", import.meta.url), "utf8");
  const hints = [...client.matchAll(/pickerHint: "([^"]*)"/g)].map((m) => m[1] ?? "");
  assert.ok(hints.length >= 2, "client.js 应至少含 zh/en 两条 pickerHint");
  assert.ok(hints.some((hint) => hint.includes("重启")), "中文提示需说明先重启 DSH");
  assert.ok(hints.some((hint) => /restart/i.test(hint)), "英文提示需说明 restart DSH");
});
