/**
 * 只读诊断单测：`pickerDiagnostics` 必须如实反映当前目录选择器形态。
 *
 * 背景（doc/fix/20260917-remote-workspace-picker）：插件把选择器钉成 `browse`；
 * 一旦解析结果不是 browse，远端浏览器就只会看到宿主屏幕上的原生对话框，
 * 面板必须能显示出来 —— 这是"上游判定变更 / 有第二个 pin 通道"的唯一可见信号。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
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
