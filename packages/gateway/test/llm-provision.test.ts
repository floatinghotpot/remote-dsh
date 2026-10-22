/**
 * llm-provision.test.ts — 52-auto-provision-router：网关自动配置 provider + key。
 *
 * 用真实的 DSH Connection RPC 信封：请求 {type:"client-request", rpcId, method, payload}，
 * 响应 {type:"server-response", rpcId, result:{ok:true, value}}。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { provisionLlm } from "../src/llm-provision.ts";

test("52：provisionLlm 用 RPC 信封写 provider（reasoningEfforts + expectedRevision）", async () => {
  const seen: Array<{ method: string; payload: Record<string, unknown> }> = [];
  const dsh = createServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString("utf8")));
    req.on("end", () => {
      const envelope = JSON.parse(body) as { type: string; rpcId: string; method: string; payload: Record<string, unknown> };
      seen.push({ method: envelope.method, payload: envelope.payload });
      const value = envelope.method === "settings/describe" ? { namespaces: [{ ns: "llm-pi-ai", revision: 7 }] } : {};
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "server-response", rpcId: envelope.rpcId, result: { ok: true, value } }));
    });
  });
  await new Promise<void>((r) => dsh.listen(0, "127.0.0.1", () => r()));
  const dshPort = (dsh.address() as { port: number }).port;

  const hub = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        key: "sk-test",
        baseURL: "https://llm.example",
        models: [
          { id: "m1", displayName: "M1", contextWindow: 1000, maxTokens: 100, effortLevels: "low,high,max", effortDefault: "high" },
        ],
      }),
    );
  });
  await new Promise<void>((r) => hub.listen(0, "127.0.0.1", () => r()));
  const hubPort = (hub.address() as { port: number }).port;

  try {
    await provisionLlm({
      hubUrl: `http://127.0.0.1:${hubPort}`,
      token: "t",
      insecure: false,
      target: { host: "127.0.0.1", port: dshPort },
      dshAuthCookie: null,
    });
    assert.ok(seen.some((s) => s.method === "settings/describe"), "must read revision first");
    const mutate = seen.find((s) => s.method === "settings/mutate");
    assert.ok(mutate !== undefined);
    assert.equal(mutate!.payload.expectedRevision, 7);
    const ops = mutate!.payload.ops as Array<{ path: string[]; value: unknown }>;
    const modelsOp = ops.find((o) => o.path.join(".") === "providers.rdsh-llm-router.models");
    assert.ok(modelsOp !== undefined);
    const models = modelsOp!.value as Array<{ reasoningEfforts?: Record<string, string> }>;
    assert.deepEqual(models[0]!.reasoningEfforts, { off: "", low: "low", high: "high", max: "max" });
    assert.ok(seen.some((s) => s.method === "credentials/set"));
  } finally {
    await new Promise<void>((r) => dsh.close(() => r()));
    await new Promise<void>((r) => hub.close(() => r()));
  }
});
