/**
 * llm-provision.ts — 52-auto-provision-router：网关自动配置 DSH 的 `rdsh-llm-router` provider + key。
 *
 * 流程（幂等 + 降级）：
 *   1. 开关关闭 → 直接返回；
 *   2. settings/describe → 找 `llm-pi-ai` 的 revision + 是否已有 `providers.rdsh-llm-router`；
 *      已有 → 返回（幂等）；
 *   3. Hub `/api/hosts/llm-key`（host token）→ { key, baseURL, models }；
 *   4. settings/mutate 写 provider（displayName/apiKeyEnv/api/baseURL/models 各一次 set）；
 *   5. credentials/set 写 key（RDSH_ROUTER_API_KEY）。
 * 任何 DSH API 失败 → 记日志、返回（不阻断网关；保留手工配置路径）。
 */
import { request as httpRequest } from "node:http";
import { hubRequest } from "./join.ts";
import type { ProxyTarget } from "./proxy.ts";

const PROVIDER_ID = "rdsh-llm-router";
const PROVIDER_DISPLAY = "WhaleLink";
const API_KEY_REF = "RDSH_ROUTER_API_KEY";
const PROTOCOL = "anthropic-messages";
const NS = "llm-pi-ai";

interface LlmKeyResponse {
  key: string;
  baseURL: string;
  models: Array<{ id: string; displayName: string; contextWindow: number; maxTokens: number }>;
}

export interface ProvisionOptions {
  hubUrl: string;
  token: string;
  insecure: boolean;
  target: ProxyTarget;
  dshAuthCookie: string | null;
  enabled: boolean;
}

function dshJson(target: ProxyTarget, cookie: string | null, path: string, body: unknown): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    const req = httpRequest(
      {
        host: target.host,
        port: target.port,
        path,
        method: "POST",
        headers: { "content-type": "application/json", ...(cookie !== null ? { cookie } : {}) },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          if ((res.statusCode ?? 0) !== 200) {
            resolve(null);
            return;
          }
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);
          } catch {
            resolve(null);
          }
        });
      },
    );
    req.on("error", () => resolve(null));
    req.setTimeout(10_000, () => req.destroy());
    req.end(JSON.stringify(body ?? {}));
  });
}

/** 读 `llm-pi-ai` 的 revision 与是否已配置 provider；失败返回 null。 */
async function readProviderState(target: ProxyTarget, cookie: string | null): Promise<{ revision: number; exists: boolean } | null> {
  const desc = await dshJson(target, cookie, "/api/settings/describe", {});
  if (desc === null) return null;
  const namespaces = desc.namespaces as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(namespaces)) return null;
  const ns = namespaces.find((n) => n.ns === NS);
  if (ns === undefined) return null;
  const value = (ns.value ?? {}) as Record<string, unknown>;
  const providers = (value.providers ?? {}) as Record<string, unknown>;
  return { revision: typeof ns.revision === "number" ? ns.revision : 0, exists: providers[PROVIDER_ID] !== undefined };
}

export async function provisionLlm(opts: ProvisionOptions): Promise<void> {
  if (!opts.enabled) return;
  const state = await readProviderState(opts.target, opts.dshAuthCookie);
  if (state === null) {
    // DSH API 不可用（版本差异/未启动）→ 降级，不阻断网关。
    console.warn("rdsh: llm provision skipped (DSH settings API unavailable)");
    return;
  }
  if (state.exists) return; // 幂等

  const res = await hubRequest(opts.hubUrl, "/api/hosts/llm-key", { method: "POST", insecure: opts.insecure, body: { token: opts.token } });
  if (!res.ok) {
    console.warn(`rdsh: llm provision skipped (hub llm-key ${res.status})`);
    return;
  }
  const provision = res.body as unknown as LlmKeyResponse;
  if (typeof provision.key !== "string" || provision.key === "" || provision.baseURL === "") {
    console.warn("rdsh: llm provision skipped (no key or baseURL from hub)");
    return;
  }

  const models = provision.models.map((m) => ({
    id: m.id,
    name: m.displayName ?? m.id,
    contextWindow: m.contextWindow,
    maxTokens: m.maxTokens,
  }));
  const ops = [
    { op: "set", path: ["providers", PROVIDER_ID, "displayName"], value: PROVIDER_DISPLAY },
    { op: "set", path: ["providers", PROVIDER_ID, "apiKeyEnv"], value: API_KEY_REF },
    { op: "set", path: ["providers", PROVIDER_ID, "api"], value: PROTOCOL },
    { op: "set", path: ["providers", PROVIDER_ID, "baseURL"], value: provision.baseURL },
    { op: "set", path: ["providers", PROVIDER_ID, "models"], value: models },
  ];
  const mutated = await dshJson(opts.target, opts.dshAuthCookie, "/api/settings/mutate", { ns: NS, ops, expectedRevision: state.revision });
  if (mutated === null) {
    console.warn("rdsh: llm provision skipped (settings/mutate failed)");
    return;
  }
  const cred = await dshJson(opts.target, opts.dshAuthCookie, "/api/credentials/set", { ref: API_KEY_REF, value: provision.key });
  if (cred === null) {
    console.warn("rdsh: llm provision: provider written but credentials/set failed");
    return;
  }
  console.log(`rdsh: llm provision ok (provider=${PROVIDER_ID} baseURL=${provision.baseURL} models=${models.length})`);
}
