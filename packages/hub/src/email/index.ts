/**
 * email/index.ts — EmailSender 工厂 + 导出。
 */
import type { EmailConfig, EmailSender } from "./types.ts";
import { createSmtpSender } from "./smtp.ts";
import { createAliyunSender } from "./aliyun.ts";
import { createLogSender } from "./log.ts";

export type { EmailMessage, EmailSender, EmailConfig, SmtpConfig, AliyunConfig } from "./types.ts";
export { percentEncode, rpcSignature } from "./aliyun.ts";

/** 按 config.email.provider 创建 sender；无 email 配置 → null（邮件功能禁用）。 */
export function createEmailSender(config?: EmailConfig): EmailSender | null {
  if (config === undefined) return null;
  switch (config.provider) {
    case "smtp":
      return createSmtpSender(config);
    case "aliyun":
      return createAliyunSender(config);
    case "log":
      return createLogSender();
    default:
      return null;
  }
}
