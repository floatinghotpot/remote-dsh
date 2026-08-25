/**
 * email/log.ts — log provider：只落日志，不真发（测试/本地/无邮件服务的自托管）。
 */
import { appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { EmailMessage, EmailSender } from "./types.ts";

export function createLogSender(): EmailSender {
  return {
    async send(msg: EmailMessage): Promise<void> {
      const line = `${new Date().toISOString()} to=${msg.to} subject=${msg.subject}\n`;
      try {
        appendFileSync(join(homedir(), ".rdsh", "hub-email.log"), line);
      } catch {
        /* 忽略写日志失败 */
      }
      console.log(`[email:log] ${msg.to}: ${msg.subject}`);
    },
  };
}
