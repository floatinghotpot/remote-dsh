/**
 * service-families.ts — 68：模型族（family）校验。
 *
 * 同一模型代理（service）的上游只能指向「同一模型」：例如 deepseek-asr 不能配
 * volc.seedasr.*（豆包 ASR）。family 是可选元数据（services.params.family 与
 * provider_configs.<capability>.modelFamilies[upstream]）；两侧都有时才校验，
 * 旧数据缺元数据时放行，避免升级期误拦。
 */
export function parseParams(raw: string | null): Record<string, unknown> {
  try {
    const v = JSON.parse(raw ?? "{}") as unknown;
    return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function readFamily(raw: string | null): string | undefined {
  const v = parseParams(raw).family;
  return typeof v === "string" && v !== "" ? v : undefined;
}

export function readModelFamily(raw: string | null, capability: string, upstream: string | null): string | undefined {
  if (upstream === null) return undefined;
  const cap = parseParams(raw)[capability];
  if (typeof cap !== "object" || cap === null) return undefined;
  const map = (cap as Record<string, unknown>).modelFamilies;
  if (typeof map !== "object" || map === null) return undefined;
  const fam = (map as Record<string, unknown>)[upstream];
  return typeof fam === "string" && fam !== "" ? fam : undefined;
}

/** true = 两侧 family 都有且不一致（应拒绝）。 */
export function familyMismatch(
  serviceParams: string | null,
  providerParams: string | null,
  capability: string,
  upstream: string | null,
): boolean {
  const svc = readFamily(serviceParams);
  const up = readModelFamily(providerParams, capability, upstream);
  return svc !== undefined && up !== undefined && svc !== up;
}
