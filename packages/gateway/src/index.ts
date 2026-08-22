/**
 * rdsh-gateway — host-side component. One process, two modes:
 * - `serve` (MVP): LAN auth gateway in front of a spawned `dsh web`
 * - `join` (M2): outbound tunnel endpoint connected to rdsh-hub
 */
export const NAME = "rdsh-gateway";
