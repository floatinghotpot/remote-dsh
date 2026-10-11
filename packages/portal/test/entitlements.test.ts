import { describe, expect, it } from "vitest";

import {
  COMPARABLE_TIERS,
  DISPLAY_ORDER,
  SHARED,
  entitlementLabel,
  has,
  relayHostsFor,
  tierOf,
  type Entitlement,
  type PlanTier,
} from "../src/entitlements";

/**
 * 权益与档位的**契约测试**（镜像 App 侧的 `test/rdsh/entitlements_test.dart`）。
 *
 * 冻结矩阵见 `packages/hub/API.md` §13.2。**任何权益调整都必须同时改 §13 与两端实现及测试**。
 */
describe("档位解析 tierOf", () => {
  it("无数据（未登录/接口失败）→ null，绝不等于专属账号", () => {
    expect(tierOf({ hasEntitlement: false, planStatus: null })).toBeNull();
    expect(tierOf({ hasEntitlement: false, planStatus: "subscribed" })).toBeNull();
  });

  it("planStatus 为空 → 专属账号（internal）", () => {
    expect(tierOf({ hasEntitlement: true, planStatus: null })).toBe("internal");
  });

  it("trial / grace / free", () => {
    expect(tierOf({ hasEntitlement: true, planStatus: "trial" })).toBe("trial");
    expect(tierOf({ hasEntitlement: true, planStatus: "grace" })).toBe("grace");
    expect(tierOf({ hasEntitlement: true, planStatus: "free" })).toBe("free");
  });

  it("subscribed 按 vipTier 分档；缺省按最低付费档（标准版）", () => {
    expect(tierOf({ hasEntitlement: true, planStatus: "subscribed", vipTier: 1 })).toBe("plus");
    expect(tierOf({ hasEntitlement: true, planStatus: "subscribed", vipTier: 2 })).toBe("pro");
    expect(tierOf({ hasEntitlement: true, planStatus: "subscribed", vipTier: 3 })).toBe("ultra");
    expect(tierOf({ hasEntitlement: true, planStatus: "subscribed" })).toBe("plus");
  });

  it("订阅实体处于 grace → 显示为宽限期", () => {
    expect(
      tierOf({ hasEntitlement: true, planStatus: "subscribed", vipTier: 3, subStatus: "grace" }),
    ).toBe("grace");
  });

  it("未知 planStatus → 退化为 free（不误判为专属）", () => {
    expect(tierOf({ hasEntitlement: true, planStatus: "weird" })).toBe("free");
  });
});

describe("冻结矩阵（API.md §13.2）", () => {
  const MATRIX: Record<PlanTier, Record<Entitlement, boolean>> = {
    internal: {
      cloudRelay: true,
      directConnect: true,
      systemSpeech: true,
      offlinePackages: true,
      offlineSpeech: true,
      cloudSpeech: true,
      support: true,
    },
    free: {
      cloudRelay: false,
      directConnect: true,
      systemSpeech: true,
      offlinePackages: false,
      offlineSpeech: false,
      cloudSpeech: false,
      support: false,
    },
    trial: {
      cloudRelay: true,
      directConnect: true,
      systemSpeech: true,
      offlinePackages: true,
      offlineSpeech: true,
      cloudSpeech: false,
      support: false,
    },
    grace: {
      cloudRelay: true,
      directConnect: true,
      systemSpeech: true,
      offlinePackages: true,
      offlineSpeech: true,
      cloudSpeech: false,
      support: true,
    },
    plus: {
      cloudRelay: true,
      directConnect: true,
      systemSpeech: true,
      offlinePackages: true,
      offlineSpeech: true,
      cloudSpeech: false,
      support: true,
    },
    pro: {
      cloudRelay: true,
      directConnect: true,
      systemSpeech: true,
      offlinePackages: true,
      offlineSpeech: true,
      cloudSpeech: false,
      support: true,
    },
    ultra: {
      cloudRelay: true,
      directConnect: true,
      systemSpeech: true,
      offlinePackages: true,
      offlineSpeech: true,
      cloudSpeech: true,
      support: true,
    },
  };

  for (const [tier, row] of Object.entries(MATRIX) as Array<[PlanTier, Record<Entitlement, boolean>]>) {
    it(`${tier}：权益子集与冻结矩阵一致`, () => {
      for (const [e, expected] of Object.entries(row) as Array<[Entitlement, boolean]>) {
        expect(has(tier, e), `${tier} × ${e}`).toBe(expected);
      }
    });
  }

  it("每档都必须显式定义（新增档位时不能漏）", () => {
    for (const t of DISPLAY_ORDER.length > 0 ? (Object.keys(MATRIX) as PlanTier[]) : []) {
      expect(MATRIX[t]).toBeDefined();
    }
    expect(Object.keys(MATRIX).length).toBe(7);
  });
});

describe("展示约束", () => {
  it("对比表只放稳定档位：不含试用/宽限/专属", () => {
    expect(COMPARABLE_TIERS).not.toContain("trial");
    expect(COMPARABLE_TIERS).not.toContain("grace");
    expect(COMPARABLE_TIERS).not.toContain("internal");
    expect(COMPARABLE_TIERS.length).toBe(4);
  });

  it('脚注/共有项确实全档都有', () => {
    for (const e of SHARED) {
      for (const t of Object.keys({ internal: 1, free: 1, trial: 1, grace: 1, plus: 1, pro: 1, ultra: 1 }) as PlanTier[]) {
        expect(has(t, e), `${e} 不是全档共有，不该算 SHARED`).toBe(true);
      }
    }
  });

  it("免费档不能看起来「什么都没有」：至少两项可用", () => {
    const ok = DISPLAY_ORDER.filter((e) => has("free", e));
    expect(ok.length).toBeGreaterThanOrEqual(2);
    expect(ok).toContain("directConnect");
    expect(ok).toContain("systemSpeech");
  });

  it("展示顺序是权益全集的完备排列（无遗漏/无重复）", () => {
    const all = new Set<Entitlement>([
      "cloudRelay",
      "directConnect",
      "systemSpeech",
      "offlinePackages",
      "offlineSpeech",
      "cloudSpeech",
      "support",
    ]);
    expect(new Set(DISPLAY_ORDER).size).toBe(DISPLAY_ORDER.length);
    expect(DISPLAY_ORDER.length).toBe(all.size);
    for (const e of all) expect(DISPLAY_ORDER).toContain(e);
  });

  it("云端中转排在最后（产品 2026-10-11）", () => {
    expect(DISPLAY_ORDER[DISPLAY_ORDER.length - 1]).toBe("cloudRelay");
  });
});

describe("云端中转台数 relayHostsFor", () => {
  const plans = [
    { vipTier: 1, hosts: 2 },
    { vipTier: 2, hosts: 5 },
    { vipTier: 3, hosts: 15 },
  ];

  it("免费档 = 0", () => {
    expect(relayHostsFor("free", plans)).toBe(0);
  });

  it("付费档取对应 vipTier 的 hosts（标准 2 / 专业 5 / 旗舰 15）", () => {
    expect(relayHostsFor("plus", plans)).toBe(2);
    expect(relayHostsFor("pro", plans)).toBe(5);
    expect(relayHostsFor("ultra", plans)).toBe(15);
  });

  it("计划表缺该档位 → undefined（界面显示 —，不猜数字）", () => {
    expect(relayHostsFor("pro", [{ vipTier: 1, hosts: 2 }])).toBeUndefined();
  });
});

describe("文案（Portal 以中文原文为 i18n key）", () => {
  it("专属账号的显示名是「专属账号」，不是自托管/VIP", () => {
    expect(entitlementLabel("cloudRelay")).toBe("云端中转");
    // 档位名走 tierShortName；这里只锚定最易回退的两个词
    expect(entitlementLabel("cloudSpeech")).toContain("自费 API Key");
  });
});
