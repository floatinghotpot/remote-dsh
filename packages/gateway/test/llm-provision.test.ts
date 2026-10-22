/**
 * llm-provision.test.ts — 52-auto-provision-router：网关自动配置 provider + key。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { provisionLlm } from "../src/llm-provision.ts";

test("52：provisionLlm 把 effortLevels 写成 reasoningEfforts", async () => {
  const seen: Array<{ path: string | undefined; body: Record<string, unknown> }> = [];
  const dsh = createServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString("utf8")));
    req.on("end", () => {
      seen.push({ path: req.url, body: JSON.parse(body) as Record<string, unknown> });
      res.writeHead(200, { "content-type": "application/json" });
      // settings/describe 返回 revision（mutate 必须带它才落盘）
      res.end(req.url === "/api/settings/describe" ? JSON.stringify({ namespaces: [{ ns: "llm-pi-ai", revision: 7 }] }) : "{}");
    });
  });
  await new Promise<void>((r) => dsh.listen(0, "127.0.0.1", () => r()));
  const dshPort = (dsh.address() as { port: number }).port;

  const hub = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        key: "sk-rdsh-test",
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
    const mutate = seen.find((s) => s.path === "/api/settings/mutate");
    assert.ok(mutate !== undefined);
    const ops = (mutate!.body as { ops: Array<{ path: string[]; value: unknown }> }).ops;
    const modelsOp = ops.find((o) => o.path.join(".") === "providers.rdsh-llm-router.models");
    assert.ok(modelsOp !== undefined);
    const models = modelsOp!.value as Array<{ reasoningEfforts?: Record<string, string> }>;
    assert.deepEqual(models[0]!.reasoningEfforts, { off: "", low: "low", high: "high", max: "max" });
    assert.equal(mutate!.body.expectedRevision, 7);
    const cred = seen.find((s) => s.path === "/api/credentials/set");
    assert.ok(cred !== undefined);
  } finally {
    await new Promise<void>((r) => dsh.close(() => r()));
    await new Promise<void>((r) => hub.close(() => r()));
  }
});
