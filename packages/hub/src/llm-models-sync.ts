/**
 * llm-models-sync.ts — 51-llm-model-catalog：定时拉上游 `/models` 同步显示名/容量。
 *
 * 用 key 池中第一个 enabled 且未吊销的 key（解密）；池空则跳过本轮。失败保留上次值。
 */
import type { HubRuntime } from "./api.ts";
import { decryptKeyRow, listEnabledKeys } from "./llm-upstream-keys.ts";

export function startLlmModelSync(runtime: HubRuntime): void {
  const cfg = runtime.config.llm?.upstream;
  if (cfg === undefined) return;
  const intervalMs = cfg.syncIntervalMs ?? 600_000;

  const run = async (): Promise<void> => {
    try {
      const keys = await listEnabledKeys(runtime);
      if (keys.length === 0) return;
      const apiKey = decryptKeyRow(runtime, keys[0]!);
      const res = await fetch(`${cfg.baseURL.replace(/\/+$/, "")}/models`, { headers: { authorization: `Bearer ${apiKey}` } });
      if (!res.ok) return;
      const json = (await res.json()) as { data?: Array<{ id: string; name?: string; context_window?: number; max_output_tokens?: number }> };
      const now = Date.now();
      for (const m of json.data ?? []) {
        if (typeof m.id !== "string" || m.id === "") continue;
        const displayName = typeof m.name === "string" && m.name !== "" ? m.name : m.id;
        const contextWindow = typeof m.context_window === "number" && m.context_window > 0 ? m.context_window : 0;
        const maxTokens = typeof m.max_output_tokens === "number" && m.max_output_tokens > 0 ? m.max_output_tokens : 0;
        await runtime.store.syncLlmModelMeta(m.id, displayName, contextWindow, maxTokens, now);
      }
    } catch {
      // 同步失败保留上次值（记日志由调用方决定；此处静默）。
    }
  };

  void run();
  const timer = setInterval(() => void run(), intervalMs);
  if (typeof timer.unref === "function") timer.unref();
}
