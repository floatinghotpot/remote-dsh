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
  /** 默认 https://captcha.aliyuncs.com/ */
  endpoint?: string;
}

const DEFAULT_ENDPOINT = "https://captcha.aliyuncs.com/";

/** 调用 VerifyCaptcha 验签；通过返回 true。 */
export async function verifyCaptchaParam(config: AliyunCaptchaConfig, captchaVerifyParam: string): Promise<boolean> {
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

  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
  });
  if (!res.ok) throw new Error(`aliyun captcha HTTP ${res.status}`);
  const json = (await res.json()) as { Code?: string; Result?: { VerifyResult?: boolean } };
  if (json.Code !== undefined && json.Code !== "OK") throw new Error(`aliyun captcha error: ${json.Code}`);
  return json.Result?.VerifyResult === true;
}
