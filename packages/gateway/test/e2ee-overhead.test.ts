/**
 * E2EE 包装开销的精确判界回归（2026-09-14 第三审发现的"28 B 窗口"）。
 *
 * WS 消息转发用 `sendWsData` 判"明文 ≤ MAX_PAYLOAD_LENGTH"，但 E2EE 下密文 = 内层帧(15 B 头)
 * + AEAD nonce(12) + tag(16) = 明文 + 43 B。若明文落在 (MAX−43, MAX] 这 43 字节窗口内，
 * `encodeFrame(密文)` 会在加密发送器里抛 `ProtocolError` 打死 host。
 * 修法：`sendWsData` 判界改为 MAX − E2EE_FRAME_OVERHEAD；本测试钉死这个开销与边界，防止漂移。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeFrame, FRAME_TYPE, FLAG_E2E, ProtocolError, MAX_PAYLOAD_LENGTH } from "rdsh-tunnel";
import { Aead } from "../src/e2ee.ts";
import { E2EE_FRAME_OVERHEAD } from "../src/join.ts";

function e2eeCt(aead: Aead, buf: Buffer): Buffer {
  return aead.encrypt(encodeFrame(FRAME_TYPE.DATA, 1, buf), Buffer.alloc(0));
}

test("E2EE 包装开销 = 43 B（内层帧头 15 + nonce 12 + tag 16）", () => {
  assert.equal(E2EE_FRAME_OVERHEAD, 15 + 12 + 16);
});

test("WS 消息判界：MAX−43 恰好放得下，MAX−42 即超限（28B 窗口回归）", () => {
  const aead = new Aead(Buffer.alloc(32)); // 任意密钥：开销与密钥值无关

  const ok = e2eeCt(aead, Buffer.alloc(MAX_PAYLOAD_LENGTH - E2EE_FRAME_OVERHEAD));
  assert.ok(ok.length <= MAX_PAYLOAD_LENGTH, `MAX−${E2EE_FRAME_OVERHEAD} 的 WS 消息经 E2EE 后应 ≤ 上限（实际 ${ok.length}）`);
  assert.doesNotThrow(() => encodeFrame(FRAME_TYPE.DATA, 1, ok, FLAG_E2E), "恰好到界的密文必须能封帧");

  const over = e2eeCt(aead, Buffer.alloc(MAX_PAYLOAD_LENGTH - E2EE_FRAME_OVERHEAD + 1));
  assert.ok(over.length > MAX_PAYLOAD_LENGTH, "+1 字节即超限");
  assert.throws(() => encodeFrame(FRAME_TYPE.DATA, 1, over, FLAG_E2E), ProtocolError, "超限密文必须抛 ProtocolError（这正是要被判界挡掉的路径）");
});
