/**
 * sms/index.ts — SmsSender 工厂 + 导出。
 */
import type { SmsConfig, SmsSender } from "./types.ts";
import { createAliyunSmsSender } from "./aliyun.ts";
import { createLogSender } from "./log.ts";

export type { SmsMessage, SmsSender, SmsConfig, AliyunSmsConfig } from "./types.ts";

/** 按 config.sms.provider 创建 sender；无 sms 配置 → null（短信功能禁用）。 */
export function createSmsSender(config?: SmsConfig): SmsSender | null {
  if (config === undefined) return null;
  switch (config.provider) {
    case "aliyun": {
      if (config.aliyun === undefined) throw new Error("sms.provider=aliyun requires sms.aliyun config");
      return createAliyunSmsSender(config.aliyun);
    }
    case "log":
      return createLogSender();
    default:
      return null;
  }
}
