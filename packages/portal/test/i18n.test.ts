import { afterAll, describe, expect, it } from "vitest";

import { setLang, translate } from "../src/i18n";

/**
 * 管理台套餐状态文案的英文映射。
 *
 * Portal 的 i18n 以中文原文为 key；漏翻时 `translate` 会静默回退中文，
 * 因此这里逐个锚定，防止「英文界面又冒出中文/英文枚举」。
 */
describe("i18n：管理台套餐状态", () => {
  afterAll(() => setLang("zh"));

  it("英文覆盖全部状态标签", () => {
    setLang("en");
    expect(translate("专属账号")).toBe("Exclusive account");
    expect(translate("试用中")).toBe("Trial");
    expect(translate("宽限期")).toBe("Grace period");
    expect(translate("免费档")).toBe("Free");
    expect(translate("已订阅")).toBe("Subscribed");
    expect(translate("未知")).toBe("Unknown");
  });

  it("英文覆盖 account_status 标签", () => {
    setLang("en");
    expect(translate("正常")).toBe("Normal");
    expect(translate("封禁")).toBe("Ban");
    expect(translate("删除")).toBe("Delete");
    expect(translate("待验证")).toBe("Pending");
  });
});
