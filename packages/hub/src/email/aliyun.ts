/**
 * email/aliyun.ts — 阿里云 DirectMail（邮件推送）HTTP API provider。
 *
 * 手写 RPC V1 签名（node:crypto + 内置 fetch，零依赖）——参考 Logto
 * `@logto/connector-aliyun-dm` 生产实现 + 阿里云官方签名规范。无需 region_id：
 * 直接 POST 固定 endpoint（默认国内 dm.aliyuncs.com）。
 */
import { createHmac, randomUUID } from "node:crypto";
import type { AliyunConfig, EmailConfig, EmailMessage, EmailSender } from "./types.ts";

const DEFAULT_ENDPOINT = "https://dm.aliyuncs.com/";

/** 阿里云 RPC 签名 percent-encode（encodeURIComponent + 补齐 ! " ' ( ) * +）。 */
export function percentEncode(s: string): string {
  return encodeURIComponent(s)
    .replaceAll("!", "%21")
    .replaceAll('"', "%22")
    .replaceAll("'", "%27")
    .replaceAll("(", "%28")
    .replaceAll(")", "%29")
    .replaceAll("*", "%2A")
    .replaceAll("+", "%2B");
}

/** RPC V1 签名：HMAC-SHA1(secret&, METHOD & %2F & percentEncode(sortedQuery)) → base64。 */
export function rpcSignature(params: Record<string, string>, accessKeySecret: string, method: string): string {
  const query = Object.keys(params)
    .sort()
    .map((k) => `${percentEncode(k)}=${percentEncode(params[k]!)}`)
    .join("&");
  const stringToSign = `${method}&${percentEncode("/")}&${percentEncode(query)}`;
  return createHmac("sha1", `${accessKeySecret}&`).update(stringToSign).digest("base64");
}

export function createAliyunSender(config: EmailConfig): EmailSender {
  const aliyun: AliyunConfig | undefined = config.aliyun;
  if (aliyun === undefined) throw new Error("email.provider=aliyun 需要 email.aliyun 配置");
  const endpoint = aliyun.endpoint ?? DEFAULT_ENDPOINT;

  return {
    async send(msg: EmailMessage): Promise<void> {
      const params: Record<string, string> = {
        Action: "SingleSendMail",
        Format: "JSON",
        Version: "2015-11-23",
        AccessKeyId: aliyun.accessKeyId,
        SignatureMethod: "HMAC-SHA1",
        SignatureVersion: "1.0",
        SignatureNonce: randomUUID(),
        Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
        AccountName: config.from,
        ToAddress: msg.to,
        Subject: msg.subject,
        AddressType: "1",
        ReplyToAddress: "true",
      };
      if (config.fromAlias !== undefined) params.FromAlias = config.fromAlias;
      if (msg.html !== undefined) params.HtmlBody = msg.html;
      else if (msg.text !== undefined) params.TextBody = msg.text;
      params.Signature = rpcSignature(params, aliyun.accessKeySecret, "POST");

      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(params).toString(),
      });
      if (!res.ok) throw new Error(`aliyun dm HTTP ${res.status}`);
      const json = (await res.json()) as { Code?: string; Message?: string };
      if (json.Code !== undefined) throw new Error(`aliyun dm error: ${json.Code}${json.Message ? ` - ${json.Message}` : ""}`);
    },
  };
}
