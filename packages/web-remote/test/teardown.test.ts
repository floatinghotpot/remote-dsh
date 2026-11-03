import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";

/**
 * 生命周期测试（真实 cordis Context）：验证 `apply()` 的收尾走 `ctx.effect` disposer，
 * 且宿主 `fiber.dispose()` 会**真的执行并 await** 它——这是 0.14.0 之前「收尾从未被调用」
 * 那个 bug 的盲区。用真实 Context 而不是假 ctx，才能抓住「注册了但宿主不调用」这类回归。
 *
 * 隔离：与 singleton.test.ts 一致，临时 HOME + 动态 import，避免 autoConnect 拉起真实隧道。
 */

interface FakeWebServer {
  port: number;
  register: () => () => void;
}

function makeCtx(onRegister: () => void): Context {
  const ctx = new Context();
  const webServer: FakeWebServer = { port: 0, register: () => { onRegister(); return () => {}; } };
  ctx.provide("webServer", webServer);
  ctx.provide("connection", {});
  return ctx;
}

test("真实 cordis：fiber.dispose() 执行收尾 disposer 并复位单例", async () => {
  const home = await mkdtemp(join(tmpdir(), "rdsh-teardown-"));
  const prevHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const { apply } = await import("../src/index.ts");
    type ApplyCtx = Parameters<typeof apply>[0];

    let registerCount = 0;

    const ctx1 = makeCtx(() => { registerCount += 1; });
    apply(ctx1 as unknown as ApplyCtx);
    assert.equal(registerCount, 1, "第一个实例注册 RPC 路由");

    const ctx2 = makeCtx(() => { registerCount += 1; });
    apply(ctx2 as unknown as ApplyCtx);
    assert.equal(registerCount, 1, "第二个实例被单例拦住，零注册");

    // 关键断言：真实 fiber.dispose() 会执行收尾 disposer → 复位单例。
    await ctx1.fiber.dispose();

    const ctx3 = makeCtx(() => { registerCount += 1; });
    apply(ctx3 as unknown as ApplyCtx);
    assert.equal(registerCount, 2, "dispose 后单例已复位，第三个实例重新注册");

    await ctx3.fiber.dispose();
  } finally {
    process.env.HOME = prevHome;
    await rm(home, { recursive: true, force: true });
  }
});
