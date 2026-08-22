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
export { forwardHttp, createUpgradeProxy } from "./proxy.ts";
export type { ProxyTarget } from "./proxy.ts";

export const NAME = "rdsh-gateway";
