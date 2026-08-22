#!/usr/bin/env node
/**
 * rdsh CLI entry.
 *
 * Command tree (MVP → M2):
 *   rdsh serve           # LAN auth gateway mode (spawns dsh web)
 *   rdsh join <hub>      # public mode: pair + outbound tunnel (M2)
 *   rdsh hub ...         # hub server commands (prototype phase, TS)
 *   rdsh status          # local gateway status
 */
console.log("rdsh 0.1.0 (skeleton) — commands land with M1 MVP");
