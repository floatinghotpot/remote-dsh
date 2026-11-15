import { test } from "node:test";
import assert from "node:assert/strict";
import { familyMismatch, readFamily, readModelFamily } from "../src/service-families.ts";

test("readFamily / readModelFamily", () => {
  assert.equal(readFamily(JSON.stringify({ family: "deepseek" })), "deepseek");
  assert.equal(readFamily(null), undefined);
  assert.equal(readFamily("not-json"), undefined);
  assert.equal(readModelFamily(JSON.stringify({ asr: { modelFamilies: { "ds.asr": "deepseek" } } }), "asr", "ds.asr"), "deepseek");
  assert.equal(readModelFamily(JSON.stringify({ asr: { modelFamilies: { "ds.asr": "deepseek" } } }), "asr", "volc.x"), undefined);
  assert.equal(readModelFamily(JSON.stringify({ asr: { modelFamilies: {} } }), "asr", null), undefined);
});

test("familyMismatch：同族放行、异族拒绝、缺元数据放行", () => {
  const svc = JSON.stringify({ family: "deepseek" });
  const pcfg = JSON.stringify({ asr: { modelFamilies: { "ds.asr": "deepseek", "volc.seedasr.sauc.duration": "doubao" } } });
  assert.equal(familyMismatch(svc, pcfg, "asr", "ds.asr"), false);
  assert.equal(familyMismatch(svc, pcfg, "asr", "volc.seedasr.sauc.duration"), true);
  assert.equal(familyMismatch(null, pcfg, "asr", "volc.seedasr.sauc.duration"), false);
  assert.equal(familyMismatch(svc, null, "asr", "volc.seedasr.sauc.duration"), false);
});
