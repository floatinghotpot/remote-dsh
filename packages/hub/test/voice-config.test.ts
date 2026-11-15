import { test } from "node:test";
import assert from "node:assert/strict";
import { toVoiceProvidersFromServices } from "../src/voice-session.ts";

const svc = (service: string, capability: string, params: unknown, enabled = true) => ({
  service, capability, enabled, params: params === null ? null : JSON.stringify(params),
});
const pool = (service: string, provider: string, enabled = true) => ({ service, provider, enabled });

test("toVoiceProvidersFromServices: ASR alias + TTS voices grouped by provider", () => {
  const out = toVoiceProvidersFromServices(
    [
      svc("deepseek-asr", "asr", { aliases: ["ds.asr"] }),
      svc("deepseek-tts", "tts", { voices: ["ds.stella", "ds.tide"] }),
      svc("doubao-asr", "asr", { aliases: ["volc.bigmodel"] }),
      svc("doubao-tts", "tts", { voices: ["volc.vivi"] }),
    ],
    [
      pool("deepseek-asr", "deepseek"),
      pool("deepseek-tts", "deepseek"),
      pool("doubao-asr", "volcengine"),
      pool("doubao-tts", "volcengine"),
    ],
  );
  assert.deepEqual(out, [
    { provider: "deepseek", asrModel: "ds.asr", ttsVoices: ["ds.stella", "ds.tide"] },
    { provider: "volcengine", asrModel: "volc.bigmodel", ttsVoices: ["volc.vivi"] },
  ]);
});

test("toVoiceProvidersFromServices: disabled service/pool skipped", () => {
  const out = toVoiceProvidersFromServices(
    [svc("deepseek-asr", "asr", { aliases: ["ds.asr"] }, false), svc("deepseek-tts", "tts", { voices: ["ds.stella"] })],
    [pool("deepseek-asr", "deepseek"), pool("deepseek-tts", "deepseek", false)],
  );
  assert.deepEqual(out, []);
});

test("toVoiceProvidersFromServices: malformed params -> empty voices, service id as asrModel", () => {
  const out = toVoiceProvidersFromServices(
    [{ service: "x-asr", capability: "asr", enabled: true, params: "not-json" }],
    [pool("x-asr", "x")],
  );
  assert.deepEqual(out, [{ provider: "x", asrModel: "x-asr", ttsVoices: [] }]);
});

test("toVoiceProvidersFromServices: non-string voices filtered", () => {
  const out = toVoiceProvidersFromServices(
    [{ service: "x-tts", capability: "tts", enabled: true, params: JSON.stringify({ voices: ["a", 1, null] }) }],
    [pool("x-tts", "x")],
  );
  assert.deepEqual(out, [{ provider: "x", ttsVoices: ["a"] }]);
});
