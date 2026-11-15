/**
 * pricing/index.ts — 69：上游成本计算（按供应商规则分发）。
 *
 * 规则是代码（分时窗口、缓存命中/未命中、语音折扣由 effective 价格表达），
 * 价格数字在 `upstream_prices.rates`（micro：1 元 = 1,000,000）。
 */
export type Capability = "llm" | "asr" | "tts";

export type TokenUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens?: number;
};

export type PricingInput = {
  provider: string;
  upstreamModel: string;
  capability: Capability;
  usage: TokenUsage & { units?: number };
  at: Date;
  rates: Record<string, unknown>;
};

const MICRO_PER_MTOK = 1_000_000;

type LlmWindowRates = { input: number; output: number; cacheRead: number; cacheWrite: number };

const pad2 = (n: number): string => String(n).padStart(2, "0");

/** 北京时间（UTC+8）的日键 'YYYY-MM-DD'。与分时窗口同一时区，避免服务器 TZ 漂移。 */
export function beijingDate(at: Date = new Date()): string {
  const bj = new Date(at.getTime() + 8 * 3600_000);
  return `${bj.getUTCFullYear()}-${pad2(bj.getUTCMonth() + 1)}-${pad2(bj.getUTCDate())}`;
}

/** 北京时间（UTC+8）的星期（0=周日）与当天分钟数。 */
export function beijingParts(at: Date): { day: number; minute: number } {
  const bj = new Date(at.getTime() + 8 * 3600_000);
  return { day: bj.getUTCDay(), minute: bj.getUTCHours() * 60 + bj.getUTCMinutes() };
}

function llmCost(usage: TokenUsage, rates: LlmWindowRates): number {
  return (
    Math.ceil((usage.inputTokens * rates.input) / MICRO_PER_MTOK) +
    Math.ceil((usage.outputTokens * rates.output) / MICRO_PER_MTOK) +
    Math.ceil((usage.cacheReadTokens * rates.cacheRead) / MICRO_PER_MTOK) +
    Math.ceil((usage.cacheWriteTokens * rates.cacheWrite) / MICRO_PER_MTOK)
  );
}

function windowRates(rates: Record<string, unknown>, name: string, fallback: string): LlmWindowRates {
  const v = (rates[name] ?? rates[fallback]) as Partial<LlmWindowRates> | undefined;
  return {
    input: Number(v?.input ?? 0),
    output: Number(v?.output ?? 0),
    cacheRead: Number(v?.cacheRead ?? 0),
    cacheWrite: Number(v?.cacheWrite ?? 0),
  };
}

/** DeepSeek：工作日 9–12、14–18 为峰时，其余闲时（节假日近似为工作日）。 */
export function isDeepseekPeak(at: Date): boolean {
  const { day, minute } = beijingParts(at);
  if (day === 0 || day === 6) return false;
  return (minute >= 9 * 60 && minute < 12 * 60) || (minute >= 14 * 60 && minute < 18 * 60);
}

/** 阿里云百炼：每天 08:00–22:00 忙时，其余闲时。 */
export function isAliyunBusy(at: Date): boolean {
  const { minute } = beijingParts(at);
  return minute >= 8 * 60 && minute < 22 * 60;
}

export function computeUpstreamCost(input: PricingInput): number {
  const { provider, capability, usage, at, rates } = input;
  if (capability === "asr") {
    const perSecond = Number((rates as { perSecond?: number }).perSecond ?? 0);
    return Math.round((usage.units ?? 0) * perSecond);
  }
  if (capability === "tts") {
    const perChar = Number((rates as { perChar?: number }).perChar ?? 0);
    return Math.round((usage.units ?? 0) * perChar);
  }
  // LLM：按供应商分时窗口
  if (provider === "deepseek") {
    return llmCost(usage, windowRates(rates, isDeepseekPeak(at) ? "peak" : "offPeak", "peak"));
  }
  if (provider === "aliyun") {
    return llmCost(usage, windowRates(rates, isAliyunBusy(at) ? "busy" : "idle", "busy"));
  }
  return llmCost(usage, windowRates(rates, "peak", "busy"));
}

/** 从 upstream_prices.rates（JSON 字符串）计算成本；价格缺失/解析失败返回 0。 */
export function computeCostFromRates(
  provider: string,
  upstreamModel: string,
  capability: Capability,
  usage: TokenUsage & { units?: number },
  at: Date,
  ratesJson: string,
): number {
  let rates: Record<string, unknown>;
  try {
    rates = JSON.parse(ratesJson) as Record<string, unknown>;
  } catch {
    return 0;
  }
  return computeUpstreamCost({ provider, upstreamModel, capability, usage, at, rates });
}

/** 语音单位价（micro/秒 或 micro/字）；价格缺失返回 0。 */
export function voiceUnitRate(ratesJson: string, kind: "asr" | "tts"): number {
  try {
    const rates = JSON.parse(ratesJson) as Record<string, unknown>;
    const v = kind === "asr" ? rates.perSecond : rates.perChar;
    return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0;
  } catch {
    return 0;
  }
}
