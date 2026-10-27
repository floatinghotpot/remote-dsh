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
}

export const UPSTREAM_PROVIDERS: UpstreamProviderSpec[] = [
  { provider: "deepseek", service: "llm", credentialType: "api_key", fields: ["apiKey"] },
  { provider: "volcengine", service: "voice", credentialType: "api_key", fields: ["apiKey"] },
  { provider: "aliyun", service: "voice", credentialType: "api_key_workspace", fields: ["apiKey", "workspaceId"] },
  { provider: "tencent", service: "voice", credentialType: "ak_sk", fields: ["appId", "secretId", "secretKey"] },
  { provider: "iflytek", service: "voice", credentialType: "ak_sk", fields: ["appId", "apiKey", "apiSecret"] },
  { provider: "baidu", service: "voice", credentialType: "ak_sk", fields: ["apiKey", "secretKey"] },
  { provider: "minimax", service: "voice", credentialType: "api_key_workspace", fields: ["apiKey", "groupId"] },
];

export function providerSpec(provider: string): UpstreamProviderSpec | undefined {
  return UPSTREAM_PROVIDERS.find((p) => p.provider === provider);
}
