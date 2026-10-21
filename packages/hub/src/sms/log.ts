/**
 * sms/log.ts — log provider：只落日志，不真发（测试/本地/签名审核通过前的开发期）。
 *
 * 打印完整验证码，便于本地验证时读到码。
 */
import { appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SmsMessage, SmsSender } from "./types.ts";

export function createLogSender(): SmsSender {
  return {
    async send(msg: SmsMessage): Promise<void> {
      const line = `${new Date().toISOString()} to=${msg.to} code=${msg.code}\n`;
      try {
        appendFileSync(join(homedir(), ".rdsh", "hub-sms.log"), line);
      } catch {
        /* 忽略写日志失败 */
      }
      // 打到 stdout（systemd 下进 journalctl），正文含验证码，便于验证
      console.log(`[sms:log] to=${msg.to} code=${msg.code}`);
    },
  };
}
