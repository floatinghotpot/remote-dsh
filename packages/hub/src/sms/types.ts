/**
 * sms/types.ts — SmsSender 抽象（08-saas，镜像 EmailSender）。
 *
 * hub.json `sms` 字段决定 provider；无 sms 配置 = 短信功能禁用（手机号通道整体不可用）。
 */
export interface SmsMessage {
  /** E.164 格式（+86 11 位） */
  to: string;
  /** 6 位验证码明文 */
  code: string;
}

export interface AliyunSmsConfig {
  accessKeyId: string;
  accessKeySecret: string;
  /** 短信签名（阿里云控制台审核通过后获得） */
  signName: string;
  /** 验证码模板 Code（含 ${code} 变量） */
  templateCode: string;
  /** 默认 https://dysmsapi.aliyuncs.com/ */
  endpoint?: string;
}

export interface SmsConfig {
  provider: "aliyun" | "log";
  aliyun?: AliyunSmsConfig;
}

export interface SmsSender {
  send(msg: SmsMessage): Promise<void>;
}
