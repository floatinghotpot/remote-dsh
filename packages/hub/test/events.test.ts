/**
 * 70 A2/A3：EventHub 分桶索引 + closeUser（封号/删除关闭订阅）+ size O(1) 计数。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventHub } from "../src/events.ts";
import type { WebSocket } from "ws";

interface FakeWs {
  closed: boolean;
  closeCode: number | undefined;
}

function fakeWs(): { ws: WebSocket; state: FakeWs } {
  const state: FakeWs = { closed: false, closeCode: undefined };
  const handlers = new Map<string, Array<() => void>>();
  const ws = {
    OPEN: 1,
    readyState: 1,
    on(ev: string, fn: () => void): void {
      const list = handlers.get(ev) ?? [];
      list.push(fn);
      handlers.set(ev, list);
    },
    send(): void {},
    close(code?: number): void {
      state.closed = true;
      state.closeCode = code;
      // 模拟 ws 库：close 后异步触发 close 事件；这里同步触发便于断言。
      for (const fn of handlers.get("close") ?? []) fn();
    },
  } as unknown as WebSocket;
  return { ws, state };
}

test("EventHub：按 userId 分桶 + size 计数 + closeUser 关闭该用户全部订阅", () => {
  const hub = new EventHub();
  const a1 = fakeWs();
  const a2 = fakeWs();
  const b1 = fakeWs();
  hub.add(a1.ws, 1);
  hub.add(a2.ws, 1);
  hub.add(b1.ws, 2);
  assert.equal(hub.size(), 3);

  hub.closeUser(1);
  assert.equal(a1.state.closed, true);
  assert.equal(a2.state.closed, true);
  assert.equal(a1.state.closeCode, 4401);
  assert.equal(b1.state.closed, false, "userId 2 的订阅不受影响");
  assert.equal(hub.size(), 1, "closeUser 触发 close 事件后计数回落");
});

test("EventHub：pushToUser 只命中目标用户桶", () => {
  const hub = new EventHub();
  const a = fakeWs();
  const b = fakeWs();
  hub.add(a.ws, 1);
  hub.add(b.ws, 2);
  // b 的 send 记下调用，验证不会收到 userId 1 的事件。
  let bReceived = 0;
  (b.ws as unknown as { send: () => void }).send = () => {
    bReceived += 1;
  };
  hub.pushToUser(1, { type: "host.online", hostId: "h1" });
  assert.equal(bReceived, 0, "userId 2 不应收到 userId 1 的事件");
});
