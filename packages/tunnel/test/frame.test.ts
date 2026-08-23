/**
 * frame.test.ts — 协议一致性测试（与 PROTOCOL.md 逐字段对照）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  encodeFrame,
  FrameParser,
  ProtocolError,
  jsonPayload,
  parseJsonPayload,
  FRAME_HEADER_LENGTH,
  MAX_PAYLOAD_LENGTH,
  MAGIC,
  PROTOCOL_VERSION,
  FRAME_TYPE,
  FLAG_E2E,
} from "../src/index.ts";
import type { Frame } from "../src/index.ts";

test("帧头逐字段符合 PROTOCOL.md（magic/version/flags/type/streamId/length）", () => {
  const frame = encodeFrame(FRAME_TYPE.DATA, 7, Buffer.from("hello"));
  assert.equal(frame.length, FRAME_HEADER_LENGTH + 5);
  assert.deepEqual(frame.subarray(0, 4), MAGIC);
  assert.equal(frame[4], PROTOCOL_VERSION);
  assert.equal(frame[5], 0); // flags
  assert.equal(frame[6], FRAME_TYPE.DATA);
  assert.equal(frame.readUInt32BE(7), 7); // streamId 大端
  assert.equal(frame.readUInt32BE(11), 5); // length 大端
  assert.equal(frame.subarray(FRAME_HEADER_LENGTH).toString("utf8"), "hello");
});

test("JSON payload（OPEN/CLOSE/PING/PONG/ERROR）编解码", () => {
  const open = encodeFrame(FRAME_TYPE.OPEN, 1, jsonPayload({ kind: "http", method: "POST", path: "/api/x" }));
  const parsed = new FrameParser().push(open);
  assert.equal(parsed.length, 1);
  const p = parseJsonPayload(parsed[0]!);
  assert.equal(p.kind, "http");
  assert.equal(p.path, "/api/x");
});

test("粘包：一个 chunk 多帧全部解出", () => {
  const f1 = encodeFrame(FRAME_TYPE.DATA, 1, Buffer.from("a"));
  const f2 = encodeFrame(FRAME_TYPE.DATA, 2, Buffer.from("bb"));
  const f3 = encodeFrame(FRAME_TYPE.CLOSE, 2, jsonPayload({ code: 0 }));
  const parser = new FrameParser();
  const frames = parser.push(Buffer.concat([f1, f2, f3]));
  assert.equal(frames.length, 3);
  assert.deepEqual(frames.map((f) => [f.type, f.streamId]), [
    [FRAME_TYPE.DATA, 1],
    [FRAME_TYPE.DATA, 2],
    [FRAME_TYPE.CLOSE, 2],
  ]);
});

test("半帧：分多次 push 逐字节到达", () => {
  const frame = encodeFrame(FRAME_TYPE.DATA, 42, Buffer.from("hello world"));
  const parser = new FrameParser();
  let total = 0;
  for (const byte of frame) {
    const frames = parser.push(Buffer.from([byte]));
    total += frames.length;
  }
  assert.equal(total, 1);
  const out = parser.push(Buffer.alloc(0));
  assert.equal(out.length, 0); // 无剩余
});

test("空 payload 帧（PING）", () => {
  const parser = new FrameParser();
  const frames = parser.push(encodeFrame(FRAME_TYPE.PING, 0, jsonPayload({ ts: 123 })));
  assert.equal(frames.length, 1);
  assert.equal(frames[0]!.payload.length > 0, true);
});

test("streamId 大端：> 255 的流 id", () => {
  const frame = encodeFrame(FRAME_TYPE.DATA, 0x1234abcd, Buffer.from("x"));
  const out = new FrameParser().push(frame);
  assert.equal(out[0]!.streamId, 0x1234abcd);
});

test("E2E 预留位：未知 flags 位原样透传（不丢弃）", () => {
  const flags = FLAG_E2E | 0x80; // bit0 + 未知 bit7
  const frame = encodeFrame(FRAME_TYPE.DATA, 1, Buffer.from("x"), flags);
  const out = new FrameParser().push(frame);
  assert.equal(out[0]!.flags, flags); // 原样保留，实现不解释
});

test("大 payload 分片转发（接近上限）", () => {
  const big = Buffer.alloc(MAX_PAYLOAD_LENGTH - 1, 0x41);
  const frame = encodeFrame(FRAME_TYPE.DATA, 9, big);
  const out = new FrameParser().push(frame);
  assert.equal(out.length, 1);
  assert.equal(out[0]!.payload.length, big.length);
});

test("超限 payload → ProtocolError", () => {
  assert.throws(
    () => encodeFrame(FRAME_TYPE.DATA, 1, Buffer.alloc(MAX_PAYLOAD_LENGTH + 1)),
    ProtocolError,
  );
});

test("非法 magic → ProtocolError", () => {
  const parser = new FrameParser();
  assert.throws(
    () => parser.push(Buffer.from([0x00, 0x00, 0x00, 0x00, 1, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0])),
    ProtocolError,
  );
});

test("版本不符 → ProtocolError", () => {
  const header = Buffer.alloc(FRAME_HEADER_LENGTH);
  MAGIC.copy(header, 0);
  header[4] = 99; // 未来版本
  header[6] = FRAME_TYPE.PING;
  const parser = new FrameParser();
  assert.throws(() => parser.push(header), ProtocolError);
});

test("解析器连续使用（多段输入）", () => {
  const parser = new FrameParser();
  const a = encodeFrame(FRAME_TYPE.OPEN, 1, jsonPayload({ kind: "http", method: "GET", path: "/" }));
  const b = encodeFrame(FRAME_TYPE.DATA, 1, Buffer.from("body"));
  const split = Math.floor(a.length / 2);
  const first = parser.push(a.subarray(0, split));
  const rest = parser.push(Buffer.concat([a.subarray(split), b]));
  assert.equal(first.length, 0); // 半帧
  assert.equal(rest.length, 2); // 补全 a + b
  assert.equal(rest[0]!.type, FRAME_TYPE.OPEN);
  assert.equal(rest[1]!.payload.toString("utf8"), "body");
});
