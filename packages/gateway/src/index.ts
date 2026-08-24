/**
 * rdsh-gateway — host-side component. One process, two modes:
 * - `serve` (MVP): LAN auth gateway in front of a spawned `dsh web`
 * - `join` (M2): outbound tunnel endpoint connected to rdsh-hub
 */
export { serve } from "./serve.ts";
export type { ServeOptions } from "./serve.ts";
export { SessionManager, SESSION_COOKIE, sessionTokenFromCookie } from "./session.ts";
export type { SessionPayload } from "./session.ts";
export { PairManager } from "./pair.ts";
export { startGateway } from "./server.ts";
export type { GatewayOptions, RunningGateway } from "./server.ts";
export { findDsh, spawnDsh } from "./spawn-dsh.ts";
export type { SpawnedDsh } from "./spawn-dsh.ts";
export { forwardHttp, createUpgradeProxy, rewriteHeadersForDsh } from "./proxy.ts";
export type { ProxyTarget } from "./proxy.ts";
export { loadConfig, normalizeConfig, resolveConfigPath, saveConfig, DEFAULT_HOST_CONFIG_PATH } from "./config.ts";
export type { RdshConfig, AuthMode, AuthUser, AuthConfig, TlsConfig, HostMode } from "./config.ts";
export { hashPassword, verifyPassword, UserManager } from "./auth.ts";
export { ipInCidrs, parseCidr, ipToInt } from "./cidr.ts";
export { loadTls } from "./tls.ts";
export type { TlsMaterial } from "./tls.ts";
export { loginPageHtml } from "./login-page.ts";
export { installService, uninstallService, serviceStatus, systemdUnit, launchdPlist, SERVICE_NAME, JOIN_SERVICE_NAME, HOST_SERVICE_NAME, HUB_SERVICE_NAME } from "./service.ts";
export type { ServiceSpec } from "./service.ts";

export const NAME = "rdsh-gateway";
export { join, registerJoin, detectInsecure, selfRevoke } from "./join.ts";
export type { JoinOptions, RegisterOutcome } from "./join.ts";
export { readPersistedToken, clearPersistedToken } from "./token-store.ts";
