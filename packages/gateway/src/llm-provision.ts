/**
 * llm-provision.ts — 52-auto-provision-router：网关自动配置 DSH 的 `rdsh-llm-router` provider + key。
 *
 * 每次网关启动执行一次（`startJoin` 顶层 fire-and-forget，重连不重跑）：
 *   1. Hub `/api/hosts/llm-key`（host token）→ { key, baseURL, models }（重签，旧 key 吊销）；
 *   2. settings/mutate 写 provider（displayName/apiKeyEnv/api/baseURL/models，5 个 set，覆盖同路径 = 幂等；
 *      `expectedRevision` 省略 = 无条件写入，网关是唯一写者，无需乐观锁）；
 *   3. credentials/set 写 key（RDSH_ROUTER_API_KEY）。
 * 任何 DSH API 失败 → 记日志、返回（不阻断网关；保留手工配置路径）。模型目录随每次启动刷新。
 */
import { request as httpRequest } from "node:http";
import { hubRequest } from "./join.ts";
import type { ProxyTarget } from "./proxy.ts";

const PROVIDER_ID = "rdsh-llm-router";
const PROVIDER_DISPLAY = "WhaleLink Managed";
const API_KEY_REF = "RDSH_ROUTER_API_KEY";
const PROTOCOL = "anthropic-messages";
const NS = "llm-pi-ai";

interface LlmKeyResponse {
  key: string;
  baseURL: string;
  models: Array<{ id: string; displayName: string; contextWindow: number; maxTokens: number; effortLevels: string | null; effortDefault: string | null }>;
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
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const done = (v: Record<string, unknown> | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(v);
    };
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
            done(null);
            return;
          }
          try {
            done(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);
          } catch {
            done(null);
          }
        });
        res.on("error", () => done(null));
      },
    );
    req.on("error", () => done(null));
    timer = setTimeout(() => req.destroy(new Error("dsh timeout")), 10_000);
    req.end(JSON.stringify(body ?? {}));
  });
}

export async function provisionLlm(opts: ProvisionOptions): Promise<void> {
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

  const models = provision.models.map((m) => {
    const model: Record<string, unknown> = { id: m.id, name: m.displayName ?? m.id, contextWindow: m.contextWindow, maxTokens: m.maxTokens };
    if (typeof m.effortLevels === "string" && m.effortLevels !== "") {
      const efforts: Record<string, string> = { off: "" };
      for (const level of m.effortLevels.split(",").map((s) => s.trim()).filter((s) => s !== "")) efforts[level] = level;
      model.reasoningEfforts = efforts;
    }
    return model;
  });
  const ops = [
    { op: "set", path: ["providers", PROVIDER_ID, "displayName"], value: PROVIDER_DISPLAY },
    { op: "set", path: ["providers", PROVIDER_ID, "apiKeyEnv"], value: API_KEY_REF },
    { op: "set", path: ["providers", PROVIDER_ID, "api"], value: PROTOCOL },
    { op: "set", path: ["providers", PROVIDER_ID, "baseURL"], value: provision.baseURL },
    { op: "set", path: ["providers", PROVIDER_ID, "models"], value: models },
  ];
  // expectedRevision 省略 = 无条件写入（网关唯一写者）。
  const mutated = await dshJson(opts.target, opts.dshAuthCookie, "/api/settings/mutate", { ns: NS, ops });
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
