/**
 * e2ee-frame-interop.test.ts — 内层帧编解码线级一致：浏览器(Uint8Array) == rdsh-tunnel(Buffer)。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeFrame as nodeEncode } from "rdsh-tunnel";
import { encodeFrame as webEncode, FrameParser as WebParser, FRAME_TYPE } from "../../portal/src/e2ee-frame.ts";

const te = new TextEncoder();
const td = new TextDecoder();

test("帧编码字节一致：浏览器(Uint8Array) == rdsh-tunnel(Buffer)", () => {
  const a = nodeEncode(0x02, 7, Buffer.from("hello"));
  const b = webEncode(0x02, 7, te.encode("hello"));
  assert.deepEqual(Buffer.from(b), a);

  const json = JSON.stringify({ kind: "http", method: "GET", path: "/api/session.list", headers: {} });
  const ja = nodeEncode(0x01, 3, Buffer.from(json));
  const jb = webEncode(0x01, 3, json);
  assert.deepEqual(Buffer.from(jb), ja);
});

test("粘包/半帧：浏览器解析器能解析 rdsh-tunnel 编码的多帧", () => {
  const f1 = nodeEncode(FRAME_TYPE.DATA, 1, Buffer.from("aaa"));
  const f2 = nodeEncode(FRAME_TYPE.CLOSE, 1, Buffer.from('{"code":0}'));
  const merged = Buffer.concat([f1, f2]);

  // 一次性推送（粘包）
  const frames = new WebParser().push(new Uint8Array(merged));
  assert.equal(frames.length, 2);
  assert.equal(frames[0]!.streamId, 1);
  assert.equal(td.decode(frames[0]!.payload), "aaa");
  assert.equal(frames[1]!.type, FRAME_TYPE.CLOSE);

  // 半帧分两段推送
  const p = new WebParser();
  const one = new Uint8Array(merged).slice(0, 10);
  const rest = new Uint8Array(merged).slice(10);
  assert.equal(p.push(one).length, 0);
  const frames2 = p.push(rest);
  assert.equal(frames2.length, 2);
  assert.equal(td.decode(frames2[0]!.payload), "aaa");
});
