/**
 * email/smtp.ts — SMTP provider（nodemailer）。
 */
import nodemailer from "nodemailer";
import type { EmailConfig, EmailMessage, EmailSender } from "./types.ts";

export function createSmtpSender(config: EmailConfig): EmailSender {
  const smtp = config.smtp;
  if (smtp === undefined) throw new Error("email.provider=smtp 需要 email.smtp 配置");
  const transport = nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.secure,
    auth: { user: smtp.user, pass: smtp.password },
  });
  return {
    async send(msg: EmailMessage): Promise<void> {
      await transport.sendMail({
        from: config.fromAlias ? `"${config.fromAlias}" <${config.from}>` : config.from,
        to: msg.to,
        subject: msg.subject,
        text: msg.text,
        html: msg.html,
      });
    },
  };
}
