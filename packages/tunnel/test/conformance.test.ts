/**
 * conformance.test.ts — consume the language-agnostic fixtures in `e2e/fixtures/`.
 *
 * The same `frames.json` is consumed by the private Go implementation
 * (`rdsh-cloud`), so a change here is a protocol change (PROTOCOL.md first).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  encodeFrame,
  FrameParser,
  FRAME_HEADER_LENGTH,
  MAGIC,
  PROTOCOL_VERSION,
} from "../src/index.ts";

interface FixtureFrame {
  name: string;
  encodedHex: string;
  version: number;
  flags: number;
  type: number;
  streamId: number;
  payloadHex: string;
}

interface Fixtures {
  protocolVersion: number;
  headerLength: number;
  cases: FixtureFrame[];
  sticky: { name: string; encodedHex: string; frames: FixtureFrame[] };
}

const fixtures = JSON.parse(
  readFileSync(new URL("../../../e2e/fixtures/frames.json", import.meta.url), "utf8"),
) as Fixtures;

test("fixtures: protocol constants match PROTOCOL.md", () => {
  assert.equal(fixtures.protocolVersion, PROTOCOL_VERSION);
  assert.equal(fixtures.headerLength, FRAME_HEADER_LENGTH);
  assert.equal(fixtures.cases.length > 0, true);
});

for (const c of fixtures.cases) {
  test(`fixture: ${c.name} decodes and re-encodes byte-identically`, () => {
    const bytes = Buffer.from(c.encodedHex, "hex");
    const frames = new FrameParser().push(bytes);
    assert.equal(frames.length, 1, "expected exactly one frame");

    const frame = frames[0]!;
    assert.equal(frame.version, c.version);
    assert.equal(frame.flags, c.flags);
    assert.equal(frame.type, c.type);
    assert.equal(frame.streamId, c.streamId);
    assert.deepEqual(frame.payload, Buffer.from(c.payloadHex, "hex"));

    const reencoded = encodeFrame(c.type, c.streamId, Buffer.from(c.payloadHex, "hex"), c.flags);
    assert.equal(reencoded.toString("hex"), c.encodedHex);
  });
}

test(`fixture: ${fixtures.sticky.name} yields all frames in order`, () => {
  const frames = new FrameParser().push(Buffer.from(fixtures.sticky.encodedHex, "hex"));
  assert.equal(frames.length, fixtures.sticky.frames.length);
  for (const [i, expected] of fixtures.sticky.frames.entries()) {
    const frame = frames[i]!;
    assert.equal(frame.version, expected.version, `frame ${i} version`);
    assert.equal(frame.flags, expected.flags, `frame ${i} flags`);
    assert.equal(frame.type, expected.type, `frame ${i} type`);
    assert.equal(frame.streamId, expected.streamId, `frame ${i} streamId`);
    assert.deepEqual(frame.payload, Buffer.from(expected.payloadHex, "hex"), `frame ${i} payload`);
  }
});

test("fixtures: magic is RDSH", () => {
  assert.deepEqual(MAGIC, Buffer.from([0x52, 0x44, 0x53, 0x48]));
});
