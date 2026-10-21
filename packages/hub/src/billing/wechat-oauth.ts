/**
 * billing/wechat-oauth.ts — 公众号 OAuth2 code→openid（jsapi 支付用）。
 *
 * openid 换取仍在 rdsh 侧完成（`appSecret` 不进 unicpay 平台，feature 36 req B2）。
 * 原 `billing/wechatpay.ts` 的商户直连支付部分已随 feature 36 下线删除。
 */
export interface WechatOauthConfig {
  /** 公众号 appid（feature 36 req B1：须与平台 `official_app_id` 一致） */
  appid: string;
  /** 公众号 appSecret（OAuth 换 openid；永不进 unicpay） */
  appSecret: string;
  /** 公网 origin（如 `https://rdsh.cn`），用于拼 OAuth 回调地址；去尾斜杠 */
  baseUrl: string;
}

export async function getWechatOpenid(appid: string, appSecret: string, code: string, fetchImpl: typeof fetch = fetch): Promise<string | null> {
  const url = `https://api.weixin.qq.com/sns/oauth2/access_token?appid=${encodeURIComponent(appid)}&secret=${encodeURIComponent(appSecret)}&code=${encodeURIComponent(code)}&grant_type=authorization_code`;
  const res = await fetchImpl(url);
  const json = (await res.json()) as { openid?: string; errcode?: number };
  if (json.errcode !== undefined || typeof json.openid !== "string" || json.openid === "") return null;
  return json.openid;
}
