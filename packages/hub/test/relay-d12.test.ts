import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeHeaders } from "../src/relay.ts";

test("D12 cookie 白名单：仅放行 rdsh_gate，剥离会话 cookie", () => {
  // 带 rdsh_gate + rdsh_session + authorization → 只保留 rdsh_gate
  const out = normalizeHeaders({
    cookie: "rdsh_session=abc; rdsh_host=xyz; rdsh_gate=gate1",
    authorization: "Bearer tok",
    "x-custom": "keep",
    connection: "upgrade",
    host: "rdsh.cn",
    upgrade: "websocket",
  } as never);
  assert.equal(out["cookie"], "rdsh_gate=gate1");
  assert.equal(out["authorization"], undefined);
  assert.equal(out["rdsh_session" as never], undefined);
  assert.equal(out["x-custom"], "keep");
  assert.equal(out["connection"], undefined);
  assert.equal(out["host"], undefined);
  assert.equal(out["upgrade"], undefined);
});

test("D12：无 rdsh_gate 时剥离全部 cookie", () => {
  const out = normalizeHeaders({ cookie: "rdsh_session=abc; rdsh_host=xyz" } as never);
  assert.equal(out["cookie"], undefined);
});

test("D12：cookie 数组形态", () => {
  const out = normalizeHeaders({ cookie: ["rdsh_session=a", "rdsh_gate=g2"] } as never);
  assert.equal(out["cookie"], "rdsh_gate=g2");
});
