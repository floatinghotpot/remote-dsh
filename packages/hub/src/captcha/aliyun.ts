/**
 * captcha/aliyun.ts — 阿里云验证码 2.0 VerifyCaptcha（后端验签，08-saas S4）。
 *
 * 复用 email/aliyun 的 rpcSignature（同一 RPC 签名机制）。前端 SDK 渲染滑块 → 回传
 * CaptchaVerifyParam → 后端调 VerifyCaptcha 验签。验证待：签名/模板审核 + sceneId 开通。
 */
import { randomUUID } from "node:crypto";
import { rpcSignature } from "../email/aliyun.ts";

export interface AliyunCaptchaConfig {
  accessKeyId: string;
  accessKeySecret: string;
  /** 验证码场景 ID（阿里云验证码 2.0 控制台创建） */
  sceneId: string;
  /** 身份标（Prefix）：开通验证码 2.0 后控制台概览页右上角获取；前端 SDK 用它拼 captcha-open 域名 */
  prefix: string;
  /** 默认 https://captcha.aliyuncs.com/ */
  endpoint?: string;
}

const DEFAULT_ENDPOINT = "https://captcha.aliyuncs.com/";

/** 验签结果：ok=false 既可能是"用户没过"，也可能是"调用出错"，靠 error 区分——排查"随机失败"的关键。 */
export interface CaptchaVerifyOutcome {
  /** 是否验签通过。 */
  ok: boolean;
  /** 阿里云 RequestId（对账/提工单用）。 */
  requestId: string | null;
  /** 阿里云返回码（成功为 "Success"；未返回为 null）。 */
  code: string | null;
  /** 调用层面的失败原因（HTTP 状态 / 网络异常 / 阿里云错误码）；"用户没过"时为 null。 */
  error: string | null;
}

/** 调用 VerifyCaptcha 验签。**不抛异常**：所有失败都体现在返回值里，便于调用方分类记日志。 */
export async function verifyCaptchaParam(config: AliyunCaptchaConfig, captchaVerifyParam: string): Promise<CaptchaVerifyOutcome> {
  const endpoint = config.endpoint ?? DEFAULT_ENDPOINT;
  const params: Record<string, string> = {
    Action: "VerifyCaptcha",
    Format: "JSON",
    Version: "2023-03-05",
    AccessKeyId: config.accessKeyId,
    SignatureMethod: "HMAC-SHA1",
    SignatureVersion: "1.0",
    SignatureNonce: randomUUID(),
    Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    CaptchaVerifyParam: captchaVerifyParam,
    SceneId: config.sceneId,
  };
  params.Signature = rpcSignature(params, config.accessKeySecret, "POST");

  let res: Response;
  try {
    res = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(params).toString(),
    });
  } catch (err) {
    return { ok: false, requestId: null, code: null, error: `network: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (!res.ok) return { ok: false, requestId: null, code: null, error: `http ${res.status}` };
  const json = (await res.json().catch(() => null)) as { RequestId?: string; Code?: string; Result?: { VerifyResult?: boolean } } | null;
  if (json === null) return { ok: false, requestId: null, code: null, error: "invalid json response" };
  const requestId = json.RequestId ?? null;
  const code = json.Code ?? null;
  // VerifyCaptcha（2023-03-05）成功响应的 Code 是 "Success"（非老式 RPC 的 "OK"）；
  // 验签不通过时同样是 Success + Result.VerifyResult=false，因此这里只拦截真正的错误响应。
  if (code !== null && code !== "Success") return { ok: false, requestId, code, error: `aliyun code ${code}` };
  return { ok: json.Result?.VerifyResult === true, requestId, code, error: null };
}
