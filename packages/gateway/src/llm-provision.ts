/**
 * llm-provision.ts — 52-auto-provision-router：网关自动配置 DSH 的 `rdsh-llm-router` provider + key。
 *
 * 每次网关启动执行一次（`startJoin` 顶层 fire-and-forget，重连不重跑）：
 *   1. settings/describe 读 `llm-pi-ai` 的 revision（DSH 不可用/缺命名空间 → 降级返回）；
 *   2. Hub `/api/hosts/llm-key`（host token）→ { key, baseURL, models }（重签，旧 key 吊销）；
 *   3. settings/mutate 写 provider（displayName/apiKeyEnv/api/baseURL/models，5 个 set，覆盖同路径 = 幂等）；
 *   4. credentials/set 写 key（RDSH_ROUTER_API_KEY）。
 * 任何 DSH API 失败 → 记日志、返回（不阻断网关；保留手工配置路径）。模型目录随每次启动刷新。
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

/** 读 `llm-pi-ai` 的 revision；DSH 不可用/缺命名空间/revision 非数字 → null。 */
async function readRevision(target: ProxyTarget, cookie: string | null): Promise<number | null> {
  const desc = await dshJson(target, cookie, "/api/settings/describe", {});
  if (desc === null) return null;
  const namespaces = desc.namespaces as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(namespaces)) return null;
  const ns = namespaces.find((n) => n.ns === NS);
  if (ns === undefined || typeof ns.revision !== "number") return null;
  return ns.revision;
}

export async function provisionLlm(opts: ProvisionOptions): Promise<void> {
  const revision = await readRevision(opts.target, opts.dshAuthCookie);
  if (revision === null) {
    console.warn("rdsh: llm provision skipped (DSH settings API unavailable)");
    return;
  }
  const res = await hubRequest(opts.hubUrl, "/api/hosts/llm-key", { method: "POST", insecure: opts.insecure, body: { token: opts.token } });
  if (!res.ok) {
    console.warn(`rdsh: llm provision skipped (hub llm-key ${res.status})`);
    return;
  }
  const provision = res.body as unknown as LlmKeyResponse;
  if (
    typeof provision.key !== "string" || provision.key === "" ||
    typeof provision.baseURL !== "string" || provision.baseURL === "" ||
    !Array.isArray(provision.models) || provision.models.length === 0
  ) {
    console.warn("rdsh: llm provision skipped (hub returned no key/baseURL/models)");
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
  const mutated = await dshJson(opts.target, opts.dshAuthCookie, "/api/settings/mutate", { ns: NS, ops, expectedRevision: revision });
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
