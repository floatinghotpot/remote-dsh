/**
 * 权益全集与各档位子集 —— Portal 侧**唯一数据源**。
 *
 * 契约来源：`packages/hub/API.md` §13（跨语言契约）。任何调整**必须先改 §13**，
 * 再同步本文件与 App（私有仓 `rdsh-app/lib/rdsh/entitlements.dart`）—— 两端都有单测。
 *
 * 判据（同 §13.2）：
 * - **消耗服务端成本**的能力（离线语音包走我方 CDN、云端中转走我方带宽与中继节点）→ 免费档不给；
 * - **端侧零成本**能力（直连、系统语音识别/合成）→ 全档开放；
 * - **云端语音识别/合成**是 BYO（用户自备 API Key、自费），零成本但按策略只给**旗舰 + 专属**。
 */

export type PlanTier =
  | "internal" // plan_status === null → 对外显示「专属账号」
  | "free"
  | "trial"
  | "grace"
  | "plus" // 标准版（vipTier 1）
  | "pro" // 专业版（vipTier 2）
  | "ultra"; // 旗舰版（vipTier 3）

export type Entitlement =
  /** 云端中转（= 内网穿透/隧道）；数量见 hostQuota（API.md §13.3） */
  | "cloudRelay"
  /** 直连（局域网 IP / 公网域名）：不占配额、不经我方服务器 */
  | "directConnect"
  /** 系统语音识别 / 合成（端侧） */
  | "systemSpeech"
  /** 离线语音包下载（ASR + TTS 两包，走我方 CDN） */
  | "offlinePackages"
  /** 离线语音识别 / 合成 */
  | "offlineSpeech"
  /** 云端语音识别 / 合成（BYO：用户自备 API Key，费用自付） */
  | "cloudSpeech"
  /** 专属人工客服 */
  | "support";

/**
 * UI 展示顺序（**唯一顺序源**）：身份卡权益清单与档位对比矩阵都从这里派生，
 * 避免两处各写一套顺序而漂移。与 App 的 `kDisplayOrder` 保持一致。
 */
export const DISPLAY_ORDER: readonly Entitlement[] = [
  "directConnect",
  "systemSpeech",
  "offlinePackages",
  "offlineSpeech",
  "support",
  "cloudSpeech",
  "cloudRelay",
];

/**
 * 全档共有 —— 对比表**也要列出这些行**，否则 free 列全是 ✗，
 * 用户会误以为"免费等于不可用"（而它其实有直连与系统语音）。
 */
export const SHARED: readonly Entitlement[] = ["directConnect", "systemSpeech"];

/**
 * 对比表展示的档位：**只列稳定的可选择档位**。
 * `trial` / `grace` 是访问者自身的临时状态（不能"选择"成为它们），只出现在身份卡；
 * `internal`（专属）**永不进入对外对比表**。
 */
export const COMPARABLE_TIERS: readonly PlanTier[] = ["free", "plus", "pro", "ultra"];

export interface TierInput {
  /**
   * 是否**成功取得**订阅响应。
   *
   * ⚠️ 必须区分「无数据」与「`plan_status` 为空」（API.md §13.1）：
   * 未登录 / `GET /api/billing/subscription` 失败时传 `false` → 返回 `null`，
   * 界面显示中性状态，**不得**显示为「专属账号」。
   */
  hasEntitlement: boolean;
  planStatus?: string | null;
  /** 商品档位（来自 `GET /api/billing/plans` 的 `vipTier`；缺省按最低付费档）。 */
  vipTier?: number | null;
  /** 订阅状态（`active` / `grace` / `expired` / `revoked`）。 */
  subStatus?: string | null;
}

/** 由订阅响应解析档位；**无数据返回 `null`**（≠ 专属账号）。 */
export function tierOf(input: TierInput): PlanTier | null {
  if (!input.hasEntitlement) return null;
  const s = input.planStatus;
  if (s === null || s === undefined) return "internal";
  switch (s) {
    case "trial":
      return "trial";
    case "grace":
      return "grace";
    case "free":
      return "free";
    case "subscribed":
      if (input.subStatus === "grace") return "grace";
      // 缺省 = 最低付费档（与 App 的 `vip_tier ?? 1` 一致，避免漏配时误授高档）
      switch (input.vipTier ?? 1) {
        case 3:
          return "ultra";
        case 2:
          return "pro";
        default:
          return "plus";
      }
    default:
      return "free"; // 未知值退化，不误判为专属
  }
}

/** 档位是否拥有某权益（冻结矩阵的代码化，见 API.md §13.2）。 */
export function has(tier: PlanTier, e: Entitlement): boolean {
  switch (e) {
    case "directConnect":
    case "systemSpeech":
      return true; // 端侧零成本 → 全档
    case "cloudRelay":
      return tier !== "free"; // 消耗我方带宽/节点
    case "offlinePackages":
    case "offlineSpeech":
      return tier !== "free"; // 走我方 CDN（trial 必须给：无 GMS/墨水屏设备唯一语音通路）
    case "cloudSpeech":
      return tier === "ultra" || tier === "internal"; // 与标准/专业拉开价差
    case "support":
      return tier !== "free" && tier !== "trial"; // 付费档 + 宽限期（挽留）+ 专属
  }
}

/**
 * 「云端中转」行取值：免费 0；其余档位由计划表给出（`PlanSpec.hosts`，见 API.md §13.3）。
 * 未配置 → `undefined`（界面显示 `—`，**不猜数字**）。
 */
export function relayHostsFor(
  tier: PlanTier,
  plans: ReadonlyArray<{ vipTier?: number; hosts?: number }>,
): number | null | undefined {
  if (tier === "free") return 0;
  const want = tier === "plus" ? 1 : tier === "pro" ? 2 : tier === "ultra" ? 3 : 0;
  if (want === 0) return undefined;
  for (const p of plans) {
    if (p.vipTier === want) return p.hosts ?? undefined;
  }
  return undefined;
}

/** 档位名（**中文原文** —— Portal 的 i18n 以中文为 key，英文查 `EN` 字典）。 */
export function tierShortName(t: PlanTier): string {
  switch (t) {
    case "internal":
      return "专属账号";
    case "free":
      return "免费档";
    case "trial":
      return "试用中";
    case "grace":
      return "宽限期";
    case "plus":
      return "标准版";
    case "pro":
      return "专业版";
    case "ultra":
      return "旗舰版";
  }
}

/** 权益名（中文原文，同上）。 */
export function entitlementLabel(e: Entitlement): string {
  switch (e) {
    case "cloudRelay":
      return "云端中转";
    case "directConnect":
      return "直连（局域网/公网）";
    case "systemSpeech":
      return "系统语音识别 / 合成";
    case "offlinePackages":
      return "离线语音包下载";
    case "offlineSpeech":
      return "离线语音识别 / 合成";
    case "cloudSpeech":
      return "云端语音（自费 API Key）";
    case "support":
      return "专属人工客服";
  }
}
