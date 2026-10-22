/**
 * llm-upstream-keys.ts — 51-llm-model-catalog：上游 key 池分配 + 解密。
 *
 * - 加权轮询 + 按 Router 粘性 TTL（默认 10 分钟，Hub 内存）。
 * - KEK 按行的 kek_version 加载（支持轮换：保留旧版本文件）。
 */
import { homedir } from "node:os";
import { join } from "node:path";
import type { HubRuntime } from "./api.ts";
import { decryptUpstreamKey, loadKek } from "./crypto-upstream-keys.ts";
import type { LlmUpstreamKeyRow } from "./db.ts";

const STICKY_TTL_MS = 10 * 60_000;

const sticky = new Map<string, { keyId: string; until: number }>();
let rr = 0;

export function kekDir(runtime: HubRuntime): string {
  const env = process.env.RDSH_LLM_UPSTREAM_KEK_DIR;
  if (env !== undefined && env !== "") return env;
  return runtime.config.llm?.upstreamKeyPool?.kekDir ?? join(homedir(), ".rdsh", "llm");
}

export function currentKekVersion(runtime: HubRuntime): number {
  return runtime.config.llm?.upstreamKeyPool?.kekVersion ?? 1;
}

export function decryptKeyRow(runtime: HubRuntime, row: LlmUpstreamKeyRow): string {
  const kek = loadKek(kekDir(runtime), row.kekVersion);
  return decryptUpstreamKey(row.keyCipher, row.dekWrapped, kek, row.kekVersion, row.id, row.provider);
}

export async function listEnabledKeys(runtime: HubRuntime): Promise<LlmUpstreamKeyRow[]> {
  const rows = await runtime.store.listLlmUpstreamKeys();
  return rows.filter((k) => k.enabled && k.revokedAt === null);
}

/** 加权轮询 + 粘性：返回选中的 key（已解密）。池空 → null。 */
export async function pickUpstreamKey(runtime: HubRuntime, routerTokenId: string): Promise<{ keyId: string; apiKey: string; provider: string } | null> {
  const keys = await listEnabledKeys(runtime);
  if (keys.length === 0) return null;
  const now = Date.now();
  for (const [k, v] of sticky) {
    if (v.until <= now) sticky.delete(k);
  }

  const hit = sticky.get(routerTokenId);
  if (hit !== undefined && hit.until > now) {
    const cur = keys.find((k) => k.id === hit.keyId);
    if (cur !== undefined) {
      return { keyId: cur.id, apiKey: decryptKeyRow(runtime, cur), provider: cur.provider };
    }
  }

  const total = keys.reduce((s, k) => s + Math.max(1, k.weight), 0);
  const target = ((rr % total) + total) % total;
  rr++;
  let acc = 0;
  let picked = keys[0]!;
  for (const k of keys) {
    acc += Math.max(1, k.weight);
    if (target < acc) { picked = k; break; }
  }

  sticky.set(routerTokenId, { keyId: picked.id, until: now + STICKY_TTL_MS });
  await runtime.store.touchLlmUpstreamKeyAssigned(picked.id, now);
  return { keyId: picked.id, apiKey: decryptKeyRow(runtime, picked), provider: picked.provider };
}
