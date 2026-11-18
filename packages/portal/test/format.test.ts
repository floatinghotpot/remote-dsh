import { describe, expect, it } from "vitest";

import { formatCredits, formatCreditsFromMicro, formatRatePoints } from "../src/format.ts";

describe("点数展示格式", () => {
  it("四舍五入为整数，不显示小数残值", () => {
    expect(formatCredits(799.9876)).toBe("800");
    expect(formatCredits(99.6)).toBe("100");
    expect(formatCredits(0.4)).toBe("0");
  });

  it("整数加千分位", () => {
    expect(formatCredits(800)).toBe("800");
    expect(formatCredits(1234.5)).toBe("1,235");
    expect(formatCredits(1234567)).toBe("1,234,567");
  });

  it("负值（流水变动）同样取整并加千分位", () => {
    expect(formatCredits(-1234)).toBe("-1,234");
    expect(formatCredits(-0.4)).toBe("0");
  });

  it("半值远离零取整，与 App（Dart round）一致", () => {
    expect(formatCredits(0.5)).toBe("1");
    expect(formatCredits(-0.5)).toBe("-1");
    expect(formatCredits(-1.5)).toBe("-2");
  });

  it("微单位入口先换算成点数（1 点数 = 10000 微单位）", () => {
    expect(formatCreditsFromMicro(800 * 10000)).toBe("800");
    expect(formatCreditsFromMicro(1234.5 * 10000)).toBe("1,235");
    expect(formatCreditsFromMicro(9999)).toBe("1");
    expect(formatCreditsFromMicro(0)).toBe("0");
  });

  it("价格费率保留微单位精度（最多 4 位小数，不把 0.0004 显示成 0）", () => {
    expect(formatRatePoints(6000)).toBe("0.6");
    expect(formatRatePoints(4)).toBe("0.0004");
    expect(formatRatePoints(0)).toBe("0");
  });
});
