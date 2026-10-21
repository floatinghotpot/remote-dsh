/**
 * 占位包自检：调用必须抛出可读错误 —— 避免"装了但静默无动作"这种最坏体验。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createAgentMesh, PACKAGE_NAME, STATUS } from "../src/index.ts";

test("placeholder: 状态与包名可读，调用即抛出未实现错误", () => {
  assert.equal(STATUS, "placeholder");
  assert.equal(PACKAGE_NAME, "dsh-agent-mesh");
  assert.throws(() => createAgentMesh(), /placeholder release/);
});
