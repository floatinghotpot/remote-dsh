/**
 * upstream-providers.ts — 55-voice-router：上游供应商枚举与凭据字段 schema。
 *
 * 单点定义 provider 白名单 + 每家 secret 字段 + 推导 credential_type。
 * Portal 依此渲染结构化表单；admin API 依此校验录入；Go 路由依 provider 名派发适配器。
 */
export type UpstreamService = "llm" | "voice";

export interface UpstreamProviderSpec {
  provider: string;
  service: UpstreamService;
  credentialType: string;
  /** secret 字段键，按序渲染为结构化输入框（不再手写 JSON）。 */
  fields: string[];
  /** 非机密参数字段键（voice 供应商：url/resourceId/voices…），`voices` 按逗号分隔处理。 */
  paramsFields?: string[];
}

export const UPSTREAM_PROVIDERS: UpstreamProviderSpec[] = [
  { provider: "deepseek", service: "llm", credentialType: "api_key", fields: ["apiKey"] },
  { provider: "deepseek", service: "voice", credentialType: "api_key", fields: ["apiKey"], paramsFields: ["asrUrl", "ttsUrl", "asrModel", "ttsVoices", "maxConcurrency"] },
  { provider: "volcengine", service: "voice", credentialType: "api_key", fields: ["apiKey"], paramsFields: ["asrUrl", "asrResourceId", "ttsUrl", "ttsResourceId", "asrModel", "ttsVoices"] },
  { provider: "aliyun", service: "voice", credentialType: "api_key_workspace", fields: ["apiKey", "workspaceId"], paramsFields: ["region", "domain", "voices"] },
  { provider: "tencent", service: "voice", credentialType: "ak_sk", fields: ["appId", "secretId", "secretKey"], paramsFields: ["region", "engineModelType", "voices"] },
  { provider: "iflytek", service: "voice", credentialType: "ak_sk", fields: ["appId", "apiKey", "apiSecret"], paramsFields: ["domain", "voices"] },
  { provider: "baidu", service: "voice", credentialType: "ak_sk", fields: ["apiKey", "secretKey"], paramsFields: ["domain", "voices"] },
  { provider: "minimax", service: "voice", credentialType: "api_key_workspace", fields: ["apiKey", "groupId"], paramsFields: ["domain", "voices"] },
];

// A provider name can map to more than one service (e.g. deepseek = llm + voice),
// so lookups must be service-aware; the key-creation path passes `service` and
// the config-upsert path only needs to know whether the name is known at all.
export function providerSpec(provider: string, service?: UpstreamService): UpstreamProviderSpec | undefined {
  return UPSTREAM_PROVIDERS.find((p) => p.provider === provider && (service === undefined || p.service === service));
}

export function providerExists(provider: string): boolean {
  return UPSTREAM_PROVIDERS.some((p) => p.provider === provider);
}
