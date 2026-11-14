import { test } from "node:test";
import assert from "node:assert/strict";
import { providerExists, providerSpec, UPSTREAM_PROVIDERS } from "../src/upstream-providers.ts";

test("UPSTREAM_PROVIDERS lists deepseek for both llm and voice", () => {
  const ds = UPSTREAM_PROVIDERS.filter((p) => p.provider === "deepseek");
  assert.deepEqual(ds.map((p) => p.service).sort(), ["llm", "voice"]);
});

test("providerSpec is service-aware for deepseek", () => {
  assert.equal(providerSpec("deepseek", "llm")?.service, "llm");
  const voice = providerSpec("deepseek", "voice");
  assert.equal(voice?.service, "voice");
  assert.deepEqual(voice?.fields, ["apiKey"]);
  assert.deepEqual(voice?.paramsFields, ["asrUrl", "ttsUrl", "asrModel", "ttsVoices"]);
});

test("volcengine voice params expose ttsVoices and asrModel", () => {
  const v = providerSpec("volcengine", "voice");
  assert.ok(v?.paramsFields?.includes("ttsVoices"));
  assert.ok(v?.paramsFields?.includes("asrModel"));
  assert.ok(!v?.paramsFields?.includes("voices"));
});

test("providerExists matches by provider name regardless of service", () => {
  assert.equal(providerExists("deepseek"), true);
  assert.equal(providerExists("nonexistent"), false);
});
