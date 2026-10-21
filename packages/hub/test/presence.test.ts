/**
 * 42-hub-write-path P0：PresenceDirectory（N2 集合替换 / TTL / N4 兼容）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { PresenceDirectory } from "../src/presence.ts";

test("presence：N2 集合替换 + 集合外主机下线", () => {
  const p = new PresenceDirectory();
  p.setNodeHosts("n1", ["h1", "h2"], 1_000);
  assert.equal(p.isOnline("h1", 1_000), true);
  assert.equal(p.isOnline("h2", 1_000), true);
  assert.equal(p.nodeIdOf("h1", 1_000), "n1");

  p.setNodeHosts("n1", ["h2", "h3"], 2_000);
  assert.equal(p.isOnline("h1", 2_000), false, "不在新集合 → 下线");
  assert.equal(p.isOnline("h2", 2_000), true);
  assert.equal(p.isOnline("h3", 2_000), true);
  assert.equal(p.size(), 2);
});

test("presence：TTL 过期（默认 90s）", () => {
  const p = new PresenceDirectory(90_000);
  p.setNodeHosts("n1", ["h1"], 0);
  assert.equal(p.isOnline("h1", 89_999), true);
  assert.equal(p.isOnline("h1", 90_001), false);
  assert.equal(p.size(), 0, "过期读取会顺手清理");
});

test("presence：N4 单主机上下线（兼容旧 relay）", () => {
  const p = new PresenceDirectory();
  p.set("h1", "n1", true, 1_000);
  assert.equal(p.isOnline("h1", 1_000), true);
  p.set("h1", "n1", false, 1_100);
  assert.equal(p.isOnline("h1", 1_100), false);
  assert.equal(p.nodeIdOf("h1", 1_100), null);
});

test("presence：不同节点集合互不误删", () => {
  const p = new PresenceDirectory();
  p.setNodeHosts("n1", ["h1"], 1_000);
  p.setNodeHosts("n2", ["h2"], 1_000);
  p.setNodeHosts("n1", [], 2_000);
  assert.equal(p.isOnline("h1", 2_000), false);
  assert.equal(p.isOnline("h2", 2_000), true, "n2 的 h2 不受 n1 影响");
});
