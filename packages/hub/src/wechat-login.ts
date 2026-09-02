/**
 * wechat-login.ts — 微信登录（网站应用 AppID，qrconnect / snsapi_login）。
 *
 * 与支付（wechatpay.ts）完全隔离：登录用「网站应用」AppID + snsapi_login，
 * 支付用「小程序/服务号」AppID。仅登录，不涉及支付。
 */
export interface WechatLoginIdentity {
  openid: string;
  /** 开放平台账号已认证时返回；未认证/未绑定 → null */
  unionid: string | null;
  nickname: string | null;
  avatar: string | null;
}

/**
 * 网站应用登录 code → openid/unionid → userinfo（昵称/头像）。
 * 1) `sns/oauth2/access_token` 换 access_token + openid(+unionid)
 * 2) `sns/userinfo` 拉昵称/头像（失败不阻塞登录）
 */
export async function exchangeWechatLoginCode(
  appid: string,
  appSecret: string,
  code: string,
  fetchImpl: typeof fetch = fetch,
): Promise<WechatLoginIdentity | null> {
  const tokenUrl =
    `https://api.weixin.qq.com/sns/oauth2/access_token?appid=${encodeURIComponent(appid)}` +
    `&secret=${encodeURIComponent(appSecret)}&code=${encodeURIComponent(code)}&grant_type=authorization_code`;
  const res = await fetchImpl(tokenUrl);
  const json = (await res.json()) as { access_token?: string; openid?: string; unionid?: string; errcode?: number };
  if (json.errcode !== undefined || typeof json.access_token !== "string" || typeof json.openid !== "string" || json.openid === "") {
    return null;
  }
  const openid = json.openid;
  const unionid = typeof json.unionid === "string" && json.unionid !== "" ? json.unionid : null;

  let nickname: string | null = null;
  let avatar: string | null = null;
  try {
    const infoUrl =
      `https://api.weixin.qq.com/sns/userinfo?access_token=${encodeURIComponent(json.access_token)}` +
      `&openid=${encodeURIComponent(openid)}&lang=zh_CN`;
    const infoRes = await fetchImpl(infoUrl);
    const info = (await infoRes.json()) as { nickname?: string; headimgurl?: string };
    if (typeof info.nickname === "string" && info.nickname !== "") nickname = info.nickname;
    if (typeof info.headimgurl === "string" && info.headimgurl !== "") avatar = info.headimgurl;
  } catch {
    // 拉取 userinfo 失败不阻塞登录（昵称/头像可空）
  }
  return { openid, unionid, nickname, avatar };
}

/** 组装网站应用登录授权 URL（qrconnect，scope=snsapi_login）。 */
export function wechatLoginUrl(appid: string, redirectUri: string, state: string): string {
  return (
    `https://open.weixin.qq.com/connect/qrconnect?appid=${encodeURIComponent(appid)}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=snsapi_login&state=${encodeURIComponent(state)}#wechat_redirect`
  );
}
