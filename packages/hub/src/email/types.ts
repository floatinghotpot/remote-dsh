/**
 * email/types.ts — EmailSender 抽象（M5 邮件提供方）。
 *
 * hub.json `email` 字段决定 provider；无 email 配置 = 邮件功能禁用。
 */
export interface EmailMessage {
  to: string;
  subject: string;
  text?: string;
  html?: string;
}

export interface SmtpConfig {
  host: string;
  port: number;
  /** true = SSL 直连（465）；false = STARTTLS（587） */
  secure: boolean;
  user: string;
  password: string;
}

export interface AliyunConfig {
  accessKeyId: string;
  accessKeySecret: string;
  /** 默认 https://dm.aliyuncs.com/（国内）；海外用 dm.ap-southeast-1.aliyuncs.com */
  endpoint?: string;
}

/** 验证码邮件模板（中英文）。占位符：{code}=6 位验证码、{brand}=品牌名（site.brand）。 */
export interface EmailCodeTemplate {
  subject: { zh: string; en: string };
  text: { zh: string; en: string };
}

export interface EmailConfig {
  provider: "smtp" | "aliyun" | "log";
  from: string;
  fromAlias?: string;
  smtp?: SmtpConfig;
  aliyun?: AliyunConfig;
  /** 验证码邮件模板（可选，缺省用内置中英文模板）。 */
  codeTemplates?: {
    verify?: EmailCodeTemplate;
    reset?: EmailCodeTemplate;
  };
}

export interface EmailSender {
  send(msg: EmailMessage): Promise<void>;
}
