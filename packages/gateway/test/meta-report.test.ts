/**
 * meta-report.test.ts — 主机类型/版本上报（63-bind-agent-box / req R29/R31/R32/R33）。
 *
 * 用本地假 hub 抓请求体，覆盖：启动即报、30 分钟节流、404 后停用、
 * device.json 覆盖显式 kind、readBoxdVersion 读取。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UsageReporter, readBoxdVersion, readDeviceKind } from "../src/join.ts";

interface Captured {
  path: string;
  body: Record<string, unknown>;
}

/** 起一个假 hub：记录收到的请求，按 statuses 依次返回。 */
async function fakeHub(statuses: number[] = [200]): Promise<{ base: string; seen: Captured[]; close: () => Promise<void> }> {
  let i = 0;
  const seen: Captured[] = [];
  const server: Server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += String(c)));
    req.on("end", () => {
      seen.push({ path: req.url ?? "", body: raw === "" ? {} : (JSON.parse(raw) as Record<string, unknown>) });
      const status = statuses[Math.min(i, statuses.length - 1)] ?? 200;
      i += 1;
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: status === 200 }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const addr = server.address();
  const port = typeof addr === "object" && addr !== null ? addr.port : 0;
  return {
    base: `http://127.0.0.1:${port}`,
    seen,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

function reporter(hub: string, opts: Partial<{ deviceKind: "box" | "cli" | "desktop"; versions: Record<string, string>; metaIntervalMs: number; role: "cli" | "plugin" }> = {}): UsageReporter {
  return new UsageReporter({
    hubUrl: hub,
    token: "host-token-0123456789abcdef",
    insecure: false,
    versions: opts.versions ?? { dsh: "0.2.1", rdsh: "0.19.1", gateway: "gateway" },
    ...(opts.deviceKind !== undefined ? { deviceKind: opts.deviceKind } : {}),
    ...(opts.metaIntervalMs !== undefined ? { metaIntervalMs: opts.metaIntervalMs } : {}),
    ...(opts.role !== undefined ? { role: opts.role } : {}),
  });
}

test("reportMeta 把 token / deviceKind / versions 报给 /api/hosts/self/meta", async () => {
  const hub = await fakeHub();
  try {
    await reporter(hub.base, { deviceKind: "box" }).reportMeta(true);
    assert.equal(hub.seen.length, 1);
    assert.equal(hub.seen[0]!.path, "/api/hosts/self/meta");
    assert.equal(hub.seen[0]!.body.token, "host-token-0123456789abcdef");
    assert.equal(hub.seen[0]!.body.deviceKind, "box");
    assert.deepEqual(hub.seen[0]!.body.versions, { dsh: "0.2.1", rdsh: "0.19.1", gateway: "gateway" });
  } finally {
    await hub.close();
  }
});

test("节流：间隔内重复调用不重复发请求", async () => {
  const hub = await fakeHub();
  try {
    const r = reporter(hub.base, { deviceKind: "cli", metaIntervalMs: 60_000 });
    await r.reportMeta(true);
    await r.reportMeta();
    await r.reportMeta();
    assert.equal(hub.seen.length, 1, "节流期内只应发一次");
    // force 绕过节流
    await r.reportMeta(true);
    assert.equal(hub.seen.length, 2);
  } finally {
    await hub.close();
  }
});

test("hub 无该端点（404）→ 停用，不再重试", async () => {
  const hub = await fakeHub([404]);
  try {
    const r = reporter(hub.base, { deviceKind: "cli" });
    await r.reportMeta(true);
    await r.reportMeta(true);
    await r.reportMeta(true);
    assert.equal(hub.seen.length, 1, "404 之后应永久停用");
  } finally {
    await hub.close();
  }
});

test("401 同样停用；200 之后保持启用", async () => {
  const unauth = await fakeHub([401]);
  try {
    const r = reporter(unauth.base, { deviceKind: "cli" });
    await r.reportMeta(true);
    await r.reportMeta(true);
    assert.equal(unauth.seen.length, 1);
  } finally {
    await unauth.close();
  }

  const ok = await fakeHub([200]);
  try {
    const r = reporter(ok.base, { deviceKind: "cli", metaIntervalMs: 0 });
    await r.reportMeta(true);
    await r.reportMeta();
    assert.equal(ok.seen.length, 2, "200 后应继续按节流上报");
  } finally {
    await ok.close();
  }
});

test("/etc/rdsh/device.json 的 kind 覆盖显式 deviceKind", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rdsh-meta-"));
  const deviceJson = join(dir, "device.json");
  writeFileSync(deviceJson, JSON.stringify({ kind: "box" }));
  const prev = process.env.RDSH_DEVICE_JSON;
  process.env.RDSH_DEVICE_JSON = deviceJson;
  const hub = await fakeHub();
  try {
    assert.equal(readDeviceKind(), "box");
    await reporter(hub.base, { deviceKind: "cli" }).reportMeta(true);
    assert.equal(hub.seen[0]!.body.deviceKind, "box", "device.json 优先");
  } finally {
    if (prev === undefined) delete process.env.RDSH_DEVICE_JSON;
    else process.env.RDSH_DEVICE_JSON = prev;
    await hub.close();
  }
});

test("device.json 缺失/非法 → null（不抛）", () => {
  const dir = mkdtempSync(join(tmpdir(), "rdsh-meta-"));
  const prev = process.env.RDSH_DEVICE_JSON;
  try {
    process.env.RDSH_DEVICE_JSON = join(dir, "missing.json");
    assert.equal(readDeviceKind(), null);
    const bad = join(dir, "bad.json");
    writeFileSync(bad, JSON.stringify({ kind: "tablet" }));
    process.env.RDSH_DEVICE_JSON = bad;
    assert.equal(readDeviceKind(), null);
  } finally {
    if (prev === undefined) delete process.env.RDSH_DEVICE_JSON;
    else process.env.RDSH_DEVICE_JSON = prev;
  }
});

test("readBoxdVersion 读 status.json 的 boxdVersion；缺失为 null", () => {
  const dir = mkdtempSync(join(tmpdir(), "rdsh-boxd-"));
  const status = join(dir, "status.json");
  const prev = process.env.RDSH_BOXD_STATUS;
  try {
    process.env.RDSH_BOXD_STATUS = status;
    assert.equal(readBoxdVersion(), null, "文件不存在 → null");
    writeFileSync(status, JSON.stringify({ state: "ONLINE", boxdVersion: "0.2.0" }));
    assert.equal(readBoxdVersion(), "0.2.0");
  } finally {
    if (prev === undefined) delete process.env.RDSH_BOXD_STATUS;
    else process.env.RDSH_BOXD_STATUS = prev;
  }
});
