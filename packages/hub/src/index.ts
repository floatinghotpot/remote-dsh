/**
 * rdsh-hub — server. Prototype phase: TypeScript (ships inside the `rdsh` npm
 * package as `rdsh hub ...`). Production phase: Go single binary.
 */
export { loadHubConfig, normalizeHubConfig, resolveHubConfigPath, DEFAULT_HUB_CONFIG_PATH } from "./config.ts";
export type { HubConfig } from "./config.ts";
export { HubDb } from "./db.ts";
export type { UserRow, HostRow, RefreshRow, HostShareRow, AuditEventRow, EmailCodeRow } from "./db.ts";
export { createEmailSender, percentEncode, rpcSignature } from "./email/index.ts";
export type { EmailMessage, EmailSender, EmailConfig, SmtpConfig, AliyunConfig } from "./email/index.ts";
export { createChallenge, verifyChallenge } from "./captcha.ts";
export { generateSecret, totp, verifyTotp } from "./totp.ts";
export { Jwt, randomToken, sha256 } from "./jwt.ts";
export type { JwtClaims } from "./jwt.ts";
export { HubAuth, hashPassword, verifyPassword, createLoginLimiter, ACCESS_TTL_MS, REFRESH_TTL_MS } from "./auth.ts";
export type { TokenPair } from "./auth.ts";
export { handleApi, authenticate, writeError, SESSION_COOKIE } from "./api.ts";
export type { HubRuntime, AuthResult } from "./api.ts";
export { TunnelConn, TunnelRegistry } from "./tunnel.ts";
export type { StreamHandler } from "./tunnel.ts";
export { EventHub, createEventsServer } from "./events.ts";
export { handleRelay, handleRelayUpgrade } from "./relay.ts";
export { startHubServer, loadHubTls } from "./server.ts";
export type { HubServerOptions, RunningHub } from "./server.ts";
export { serveHub, loadJwtKey } from "./serve.ts";
export type { HubServeOptions } from "./serve.ts";
export { servePortal, defaultPortalDir } from "./portal.ts";
