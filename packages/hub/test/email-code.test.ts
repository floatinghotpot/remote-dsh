/**
 * email-code.test.ts — 验证码邮件模板渲染（中英文分支 + {code}/{brand} 占位符替换 + 兜底）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderEmailCode } from "../src/api.ts";
import type { HubRuntime } from "../src/api.ts";
import type { HubConfig } from "../src/config.ts";

/** 最小 runtime：renderEmailCode 只读 config.email.codeTemplates + config.site.brand。 */
function rt(config: Partial<HubConfig> = {}): HubRuntime {
  return { config: config as HubConfig } as HubRuntime;
}

test("verify：lang=zh → 中文主题/正文（品牌鲸语通 + code）", () => {
  const r = renderEmailCode(rt(), "verify", "zh", "123456");
  assert.equal(r.subject, "鲸语通 验证码");
  assert.equal(r.text, "【鲸语通】您的验证码是 123456（10 分钟内有效）。");
});

test("verify：lang=en → 英文主题/正文（品牌 WhaleLink + code）", () => {
  const r = renderEmailCode(rt(), "verify", "en", "123456");
  assert.equal(r.subject, "WhaleLink verification code");
  assert.equal(r.text, "[WhaleLink] Your verification code is 123456 (valid 10 minutes).");
});

test("reset：中文与英文模板", () => {
  assert.equal(renderEmailCode(rt(), "reset", "zh", "654321").subject, "鲸语通 重置码");
  assert.equal(renderEmailCode(rt(), "reset", "zh", "654321").text, "【鲸语通】您的重置码是 654321（10 分钟内有效）。");
  assert.equal(renderEmailCode(rt(), "reset", "en", "654321").text, "[WhaleLink] Your password reset code is 654321 (valid 10 minutes).");
});

test("lang 缺省/非 zh → 英文兜底", () => {
  assert.equal(renderEmailCode(rt(), "verify", undefined, "1").subject, "WhaleLink verification code");
  assert.equal(renderEmailCode(rt(), "verify", "fr", "1").subject, "WhaleLink verification code");
  assert.equal(renderEmailCode(rt(), "verify", "", "1").subject, "WhaleLink verification code");
});

test("自定义 codeTemplates 覆盖内置模板", () => {
  const cfg: Partial<HubConfig> = {
    email: {
      provider: "log",
      from: "x@y",
      codeTemplates: {
        verify: {
          subject: { zh: "【{brand}】验证", en: "[{brand}] verify" },
          text: { zh: "码：{code}", en: "code: {code}" },
        },
      },
    },
  };
  const r = renderEmailCode(rt(cfg), "verify", "zh", "9");
  assert.equal(r.subject, "【鲸语通】验证");
  assert.equal(r.text, "码：9");
  assert.equal(renderEmailCode(rt(cfg), "verify", "en", "9").text, "code: 9");
});

test("只配 verify 模板 → reset 用内置兜底", () => {
  const cfg: Partial<HubConfig> = {
    email: {
      provider: "log",
      from: "x@y",
      codeTemplates: {
        verify: { subject: { zh: "v", en: "v" }, text: { zh: "v", en: "v" } },
      },
    },
  };
  assert.equal(renderEmailCode(rt(cfg), "reset", "zh", "8").subject, "鲸语通 重置码");
});

test("site.brand 缺 en → 英文兜底 WhaleLink；zh 用配置值", () => {
  const cfg: Partial<HubConfig> = { site: { brand: { zh: "自定义中文" } } };
  assert.equal(renderEmailCode(rt(cfg), "verify", "zh", "1").text.includes("自定义中文"), true);
  assert.equal(renderEmailCode(rt(cfg), "verify", "en", "1").text.includes("WhaleLink"), true);
});

test("site.brand 完整配置 → 用配置品牌（配置优先于兜底）", () => {
  const cfg: Partial<HubConfig> = { site: { brand: { zh: "自定义", en: "Custom" } } };
  assert.equal(renderEmailCode(rt(cfg), "verify", "zh", "1").subject, "自定义 验证码");
  assert.equal(renderEmailCode(rt(cfg), "verify", "en", "1").subject, "Custom verification code");
});

test("占位符多次出现都能替换", () => {
  const cfg: Partial<HubConfig> = {
    email: {
      provider: "log",
      from: "x@y",
      codeTemplates: {
        verify: { subject: { zh: "{code}-{code}", en: "{code}-{code}" }, text: { zh: "{brand}{brand}", en: "{brand}{brand}" } },
      },
    },
  };
  const r = renderEmailCode(rt(cfg), "verify", "zh", "42");
  assert.equal(r.subject, "42-42");
  assert.equal(r.text, "鲸语通鲸语通");
});
