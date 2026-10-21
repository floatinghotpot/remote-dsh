/**
 * e2ee-frame.ts — 内层帧编解码（浏览器版，Uint8Array，与 rdsh-tunnel 帧格式线级一致）。
 *
 * 内层多路复用复用 tunnel 帧语义（OPEN http/ws + DATA + CLOSE + PING/PONG + ERROR），
 * 跑在 Noise 通道内。帧布局：magic "RDSH"(4B) | version(1) | flags(1) | type(1) | streamId(4B BE) | length(4B BE) | payload。
 * 注意：本文件不依赖 Buffer（浏览器无 Buffer），故独立于 rdsh-tunnel 的 Buffer 版。
 */
const MAGIC = new Uint8Array([0x52, 0x44, 0x53, 0x48]); // "RDSH"
const HEADER_LEN = 15;
const te = new TextEncoder();
const td = new TextDecoder();

export const FRAME_TYPE = {
  OPEN: 0x01,
  DATA: 0x02,
  CLOSE: 0x03,
  PING: 0x04,
  PONG: 0x05,
  ERROR: 0x06,
} as const;

export interface Frame {
  flags: number;
  type: number;
  streamId: number;
  payload: Uint8Array;
}

/** 编码一帧（payload 为 Uint8Array 或 JSON 字符串）。 */
export function encodeFrame(type: number, streamId: number, payload: Uint8Array | string, flags = 0): Uint8Array {
  const p = typeof payload === "string" ? te.encode(payload) : payload;
  const out = new Uint8Array(HEADER_LEN + p.length);
  out.set(MAGIC, 0);
  out[4] = 1; // version
  out[5] = flags;
  out[6] = type;
  const view = new DataView(out.buffer);
  view.setUint32(7, streamId >>> 0, false);
  view.setUint32(11, p.length >>> 0, false);
  out.set(p, HEADER_LEN);
  return out;
}

export function jsonPayload(obj: unknown): Uint8Array {
  return te.encode(JSON.stringify(obj));
}

export function parseJsonPayload(frame: Frame): Record<string, unknown> {
  return JSON.parse(td.decode(frame.payload)) as Record<string, unknown>;
}

/** 流式帧解析器（粘包/半帧处理）。 */
export class FrameParser {
  private buf = new Uint8Array(0);

  push(chunk: Uint8Array): Frame[] {
    const merged = new Uint8Array(this.buf.length + chunk.length);
    merged.set(this.buf, 0);
    merged.set(chunk, this.buf.length);
    this.buf = merged;

    const frames: Frame[] = [];
    for (;;) {
      if (this.buf.length < HEADER_LEN) break;
      for (let i = 0; i < 4; i++) {
        if (this.buf[i] !== MAGIC[i]) throw new Error("e2ee-frame: invalid magic");
      }
      const view = new DataView(this.buf.buffer, this.buf.byteOffset, this.buf.byteLength);
      const length = view.getUint32(11, false);
      const total = HEADER_LEN + length;
      if (this.buf.length < total) break; // 半帧
      frames.push({
        flags: this.buf[5]!,
        type: this.buf[6]!,
        streamId: view.getUint32(7, false),
        payload: this.buf.slice(HEADER_LEN, total),
      });
      this.buf = this.buf.slice(total);
    }
    return frames;
  }
}
