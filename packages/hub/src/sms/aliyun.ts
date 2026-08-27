/**
 * sms/aliyun.ts — 阿里云短信服务（dysmsapi）HTTP API provider。
 *
 * 手写 RPC V1 签名，复用 email/aliyun.ts 的 percentEncode/rpcSignature（同一机制，
 * 一套签名代码三用：DirectMail / 短信 / 验证码）。Action=SendSms，Version=2017-05-25。
 */
import { randomUUID } from "node:crypto";
import { rpcSignature } from "../email/aliyun.ts";
import type { AliyunSmsConfig, SmsMessage, SmsSender } from "./types.ts";

const DEFAULT_ENDPOINT = "https://dysmsapi.aliyuncs.com/";

export function createAliyunSmsSender(config: AliyunSmsConfig): SmsSender {
  const endpoint = config.endpoint ?? DEFAULT_ENDPOINT;

  return {
    async send(msg: SmsMessage): Promise<void> {
      const params: Record<string, string> = {
        Action: "SendSms",
        Format: "JSON",
        Version: "2017-05-25",
        AccessKeyId: config.accessKeyId,
        SignatureMethod: "HMAC-SHA1",
        SignatureVersion: "1.0",
        SignatureNonce: randomUUID(),
        Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
        PhoneNumbers: msg.to,
        SignName: config.signName,
        TemplateCode: config.templateCode,
        TemplateParam: JSON.stringify({ code: msg.code }),
      };
      params.Signature = rpcSignature(params, config.accessKeySecret, "POST");

      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(params).toString(),
      });
      if (!res.ok) throw new Error(`aliyun sms HTTP ${res.status}`);
      const json = (await res.json()) as { Code?: string; Message?: string; BizId?: string };
      if (json.Code !== undefined && json.Code !== "OK") {
        throw new Error(`aliyun sms error: ${json.Code}${json.Message ? ` - ${json.Message}` : ""}`);
      }
    },
  };
}
