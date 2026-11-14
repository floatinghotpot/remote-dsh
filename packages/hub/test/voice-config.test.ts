import { test } from "node:test";
import assert from "node:assert/strict";
import { toVoiceProviders } from "../src/voice-session.ts";

test("toVoiceProviders: ttsVoices + asrModel", () => {
  const out = toVoiceProviders([
    { provider: "deepseek", params: JSON.stringify({ asrModel: "ds.asr", ttsVoices: ["ds.stella", "ds.tide"] }) },
    { provider: "volcengine", params: JSON.stringify({ asrModel: "volc.bigmodel", ttsVoices: ["volc.vivi"] }) },
  ]);
  assert.deepEqual(out, [
    { provider: "deepseek", asrModel: "ds.asr", ttsVoices: ["ds.stella", "ds.tide"] },
    { provider: "volcengine", asrModel: "volc.bigmodel", ttsVoices: ["volc.vivi"] },
  ]);
});

test("toVoiceProviders: falls back to legacy voices during migration", () => {
  const out = toVoiceProviders([{ provider: "volcengine", params: JSON.stringify({ voices: ["volc.a"] }) }]);
  assert.deepEqual(out, [{ provider: "volcengine", ttsVoices: ["volc.a"] }]);
});

test("toVoiceProviders: malformed params -> empty ttsVoices, no asrModel", () => {
  const out = toVoiceProviders([{ provider: "x", params: "not-json" }]);
  assert.deepEqual(out, [{ provider: "x", ttsVoices: [] }]);
});

test("toVoiceProviders: non-string voices filtered", () => {
  const out = toVoiceProviders([{ provider: "x", params: JSON.stringify({ ttsVoices: ["a", 1, null] }) }]);
  assert.deepEqual(out, [{ provider: "x", ttsVoices: ["a"] }]);
});
