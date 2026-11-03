import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * 单例守卫测试：桌面壳会在同一进程 apply 本插件两次。验证第二次 apply 不注册任何贡献，
 * 且收尾 disposer 复位后、新实例能重新接管。
 *
 * 隔离：apply() 末尾会 void autoConnect()，它读 ~/.rdsh/host.json 与 ~/.rdsh/join.lock。
 * 开发机上这些文件可能是 join 模式 + 有 token ⇒ 会真的拉起隧道。因此先把 HOME 指向临时
 * 目录，再动态 import（保证模块级 homedir() 读到临时 HOME），让 autoConnect 提前返回。
 *
 * 假 ctx 的 effect 必须**立即执行回调并保存返回的 disposer**（与 cordis 一致）——
 * 旧实现只计数、不执行，正是「收尾从未被调用」这个 bug 的盲区来源。
 */

interface EffectEntry {
  label: string;
  disposer: unknown;
}

interface MockCtx {
  connection: { authenticatedUrl?: unknown };
  webServer: { port: number; register: () => () => void };
  effect: (cb: () => unknown, label: string) => void;
  on: (event: string, cb: () => void) => void;
  get: (name: string) => unknown;
  effects: EffectEntry[];
  listeners: string[];
}

function makeCtx(): MockCtx {
  const effects: EffectEntry[] = [];
  const listeners: string[] = [];
  return {
    connection: {},
    webServer: { port: 52247, register: () => () => {} },
    effect(cb: () => unknown, label: string): void {
      effects.push({ label, disposer: cb() });
    },
    on(event: string, _cb: () => void): void {
      listeners.push(event);
    },
    get(_name: string): unknown {
      return undefined;
    },
    effects,
    listeners,
  };
}

test("apply 是单例：第二次零注册，收尾 disposer 复位后重新接管", async () => {
  const home = await mkdtemp(join(tmpdir(), "rdsh-singleton-"));
  const prevHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const { apply } = await import("../src/index.ts");

    const ctx1 = makeCtx();
    const ctx2 = makeCtx();
    apply(ctx1);
    apply(ctx2);

    assert.equal(ctx1.effects.length, 2, "第一个实例注册 RPC 路由 + 收尾两个 effect");
    assert.ok(ctx1.effects.some((e) => e.label.includes("teardown")), "第一个实例注册收尾 effect");
    assert.equal(ctx1.listeners.filter((e) => e === "dispose").length, 0, "不再注册 dispose 事件监听");
    assert.equal(ctx2.effects.length, 0, "第二个实例零注册（effect）");
    assert.equal(ctx2.listeners.length, 0, "第二个实例零注册（事件）");

    // 收尾 disposer 复位后，第三个实例应能重新接管；disposer 幂等，连调两次不抛。
    const teardown = ctx1.effects.find((e) => e.label.includes("teardown"))!.disposer as () => Promise<void>;
    await teardown();
    await teardown();

    const ctx3 = makeCtx();
    apply(ctx3);
    assert.equal(ctx3.effects.length, 2, "收尾复位后第三个实例重新注册");
  } finally {
    process.env.HOME = prevHome;
    await rm(home, { recursive: true, force: true });
  }
});
