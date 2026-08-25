/**
 * email/log.ts — log provider：只落日志，不真发（测试/本地/无邮件服务的自托管）。
 *
 * 打印完整正文（含验证码/PIN），以便本地验证时能读到码。
 */
import { appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { EmailMessage, EmailSender } from "./types.ts";

export function createLogSender(): EmailSender {
  return {
    async send(msg: EmailMessage): Promise<void> {
      const body = msg.text ?? msg.html ?? "";
      const line = `${new Date().toISOString()} to=${msg.to} subject=${msg.subject}\n${body}\n`;
      try {
        appendFileSync(join(homedir(), ".rdsh", "hub-email.log"), line);
      } catch {
        /* 忽略写日志失败 */
      }
      // 打到 stdout（systemd 下进 journalctl），正文含 PIN，便于验证
      console.log(`[email:log] to=${msg.to} subject=${msg.subject}\n${body}`);
    },
  };
}
