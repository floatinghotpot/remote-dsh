import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * 单例守卫测试：桌面壳会在同一进程 apply 本插件两次。验证第二次 apply 不注册任何贡献，
 * 且 dispose 后复位、新实例能重新接管。
 *
 * 隔离：apply() 末尾会 void autoConnect()，它读 ~/.rdsh/host.json 与 ~/.rdsh/join.lock。
 * 开发机上这些文件可能是 join 模式 + 有 token ⇒ 会真的拉起隧道。因此先把 HOME 指向临时
 * 目录，再动态 import（保证模块级 homedir() 读到临时 HOME），让 autoConnect 提前返回。
 */

interface MockCtx {
  connection: { authenticatedUrl?: unknown };
  webServer: { port: number };
  effect: (cb: () => unknown, label: string) => void;
  on: (event: string, cb: () => void) => void;
  get: (name: string) => unknown;
  effectCount: () => number;
  disposeCbs: Array<() => void>;
}

function makeCtx(): MockCtx {
  let effectCount = 0;
  const disposeCbs: Array<() => void> = [];
  return {
    connection: {},
    webServer: { port: 52247 },
    effect(_cb: () => unknown, _label: string): void {
      effectCount += 1;
    },
    on(event: string, cb: () => void): void {
      if (event === "dispose") disposeCbs.push(cb);
    },
    get(_name: string): unknown {
      return undefined;
    },
    effectCount: () => effectCount,
    disposeCbs,
  };
}

test("apply 是单例：第二次零注册，dispose 后复位", async () => {
  const home = await mkdtemp(join(tmpdir(), "rdsh-singleton-"));
  const prevHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const { apply } = await import("../src/index.ts");

    const ctx1 = makeCtx();
    const ctx2 = makeCtx();
    apply(ctx1);
    apply(ctx2);

    assert.equal(ctx1.effectCount(), 1, "第一个实例注册 RPC 路由");
    assert.equal(ctx1.disposeCbs.length, 1, "第一个实例注册 dispose 处理器");
    assert.equal(ctx2.effectCount(), 0, "第二个实例零注册（effect）");
    assert.equal(ctx2.disposeCbs.length, 0, "第二个实例零注册（dispose）");

    // dispose 复位后，第三个实例应能重新接管。
    for (const cb of ctx1.disposeCbs) cb();
    const ctx3 = makeCtx();
    apply(ctx3);
    assert.equal(ctx3.effectCount(), 1, "dispose 复位后第三个实例重新注册");
  } finally {
    process.env.HOME = prevHome;
    await rm(home, { recursive: true, force: true });
  }
});
