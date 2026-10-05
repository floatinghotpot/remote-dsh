/**
 * account-unbind.test.ts — 解绑「至少保留一种非密码方式」守卫（countOtherLoginMethods）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { countOtherLoginMethods } from "../src/api.ts";
import type { UserRow } from "../src/db.ts";

function user(overrides: Partial<UserRow> = {}): UserRow {
  return {
    id: 1, name: "u1", passwordHash: "scrypt:1:1:1:a:b", ver: 1, createdAt: "x", mustChange: 0,
    email: null, emailVerified: 0, totpSecret: null, failedAttempts: 0, lockedUntil: null,
    phone: null, phoneVerified: 0, accountStatus: "active", role: "user",
    planStatus: null, planExpiresAt: null, trialStartedAt: null, freeSinceAt: null, lastLoginAt: null,
    wxwebOpenid: null, wxappOpenid: null, wechatUnionid: null, wechatNickname: null, wechatAvatar: null,
    appleSub: null, appleEmail: null, appleFullName: null,
    ...overrides,
  };
}

test("密码账号 + 唯一已验证邮箱 → 解绑邮箱 = 0（拒绝）", () => {
  assert.equal(countOtherLoginMethods(user({ email: "a@x.com", emailVerified: 1 }), "email"), 0);
});

test("已验证邮箱 + 已验证手机 → 解绑邮箱 = 1（允许，还剩手机）", () => {
  assert.equal(countOtherLoginMethods(user({ email: "a@x.com", emailVerified: 1, phone: "+8613800000000", phoneVerified: 1 }), "email"), 1);
});

test("未验证邮箱不算登录方式（即使 email 字段已填）", () => {
  // 只有未验证邮箱 → 解绑邮箱 = 0（拒绝）
  assert.equal(countOtherLoginMethods(user({ email: "a@x.com", emailVerified: 0 }), "email"), 0);
  // 已验证手机 + 未验证邮箱 → 解绑手机 = 0（未验证邮箱兜不住，拒绝）
  assert.equal(countOtherLoginMethods(user({ email: "a@x.com", emailVerified: 0, phone: "+8613800000000", phoneVerified: 1 }), "phone"), 0);
});

test("微信 + 苹果 → 解绑微信 = 1（允许，还剩苹果）", () => {
  assert.equal(countOtherLoginMethods(user({ wxappOpenid: "wxapp", appleSub: "sub-1" }), "wechat"), 1);
});

test("微信建号（无密码）+ 只有微信 → 解绑微信 = 0（拒绝，防锁死）", () => {
  assert.equal(countOtherLoginMethods(user({ passwordHash: "!wechat", wxappOpenid: "wxapp" }), "wechat"), 0);
});

test("密码不计入登录方式", () => {
  // 有真实密码但无任何绑定 → 解绑任一方式都 = 0（但实际无绑定可解，此值用于说明密码不算）
  assert.equal(countOtherLoginMethods(user({}), "email"), 0);
});
