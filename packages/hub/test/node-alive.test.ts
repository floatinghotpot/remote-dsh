/**
 * N2 心跳自愈：节点被离线扫描误判 offline 后，下一次心跳应把它拉回 online。
 *
 * 背景（见 doc/fix/20261012-relay-n4-host-online）：`markNodesOffline`（30s/90s）会把
 * 停止心跳的节点置 offline，而 N2 心跳此前只落 `last_heartbeat`、不写 `status`
 * → 节点一旦被判离线就只能靠重启恢复 ✗
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { HubDb } from "../src/db.ts";

function makeDb(): HubDb {
  return new HubDb(":memory:");
}

test("markNodeAlive：offline → online", () => {
  const db = makeDb();
  db.createNode("n1", "n1", "https://n1.example", "h1", "", 0, 100, true, null);
  db.updateNodeStatus("n1", "offline");
  db.markNodeAlive("n1");
  assert.equal(db.getNodeById("n1")?.status, "online");
});

test("markNodeAlive：draining 不被改写（迁移中不可被心跳拉回，R39）", () => {
  const db = makeDb();
  db.createNode("n2", "n2", "https://n2.example", "h2", "", 0, 100, true, null);
  db.updateNodeStatus("n2", "draining");
  db.markNodeAlive("n2");
  assert.equal(db.getNodeById("n2")?.status, "draining");
});

test("markNodeAlive：已 online 保持 online（幂等）", () => {
  const db = makeDb();
  db.createNode("n3", "n3", "https://n3.example", "h3", "", 0, 100, true, null);
  db.markNodeAlive("n3");
  assert.equal(db.getNodeById("n3")?.status, "online");
});

test("markNodeAlive：未知节点不抛错", () => {
  const db = makeDb();
  assert.doesNotThrow(() => db.markNodeAlive("nope"));
});
