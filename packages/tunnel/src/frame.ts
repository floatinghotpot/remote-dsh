/**
 * frame.ts — rdsh-tunnel 帧编解码（协议见 PROTOCOL.md，FROZEN v1）。
 *
 * 帧头：magic "RDSH"(4B) | version(1B) | flags(1B) | type(1B) | streamId(4B BE) | length(4B BE)
 * 跨语言契约：TS ↔ Go 必须逐字段一致；变更先改 PROTOCOL.md。
 */
import { MAGIC, PROTOCOL_VERSION, FRAME_TYPE } from "./constants.ts";
export { MAGIC, PROTOCOL_VERSION, FRAME_TYPE };

export const FRAME_HEADER_LENGTH = 15;
/** 单帧 payload 上限（DATA 分片转发；超出属协议错误，防恶意超大帧内存攻击）。 */
export const MAX_PAYLOAD_LENGTH = 16 * 1024 * 1024;

export interface Frame {
  version: number;
  flags: number;
  type: number;
  streamId: number;
  payload: Buffer<ArrayBufferLike>;
}

/** 协议级错误（magic 不符 / 版本不符 / 超长 / 非法流）。 */
export class ProtocolError extends Error {}

/** 编码一帧。payload 为 Buffer 或 JSON 字符串（OPEN/CLOSE/PING/PONG/ERROR 用）。 */
export function encodeFrame(type: number, streamId: number, payload: Buffer<ArrayBufferLike> | string, flags = 0): Buffer {
  const payloadBuf = typeof payload === "string" ? Buffer.from(payload, "utf8") : payload;
  if (payloadBuf.length > MAX_PAYLOAD_LENGTH) {
    throw new ProtocolError(`payload too large: ${payloadBuf.length} > ${MAX_PAYLOAD_LENGTH}`);
  }
  const header = Buffer.alloc(FRAME_HEADER_LENGTH);
  MAGIC.copy(header, 0);
  header[4] = PROTOCOL_VERSION;
  header[5] = flags;
  header[6] = type;
  header.writeUInt32BE(streamId, 7);
  header.writeUInt32BE(payloadBuf.length, 11);
  return Buffer.concat([header, payloadBuf]);
}

function parseHeader(buf: Buffer): Omit<Frame, "payload"> {
  for (let i = 0; i < 4; i++) {
    if (buf[i] !== MAGIC[i]) {
      throw new ProtocolError("invalid magic: not an rdsh-tunnel frame");
    }
  }
  const version = buf[4]!;
  if (version !== PROTOCOL_VERSION) {
    throw new ProtocolError(`unsupported protocol version: ${version}`);
  }
  return {
    version,
    flags: buf[5]!,
    type: buf[6]!,
    streamId: buf.readUInt32BE(7),
  };
}

/**
 * 流式帧解析器：消费 WS message / TCP chunk，处理粘包与半帧。
 * 未知 flags 位**原样保留**在帧上（E2E 预留，透传）。
 */
export class FrameParser {
  private buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);

  /** 注入数据，返回本次解出的完整帧（可能 0..n 个）。 */
  push(chunk: Buffer): Frame[] {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    const frames: Frame[] = [];
    for (;;) {
      if (this.buffer.length < FRAME_HEADER_LENGTH) break;
      const header = parseHeader(this.buffer.subarray(0, FRAME_HEADER_LENGTH));
      const length = this.buffer.readUInt32BE(11);
      if (length > MAX_PAYLOAD_LENGTH) {
        throw new ProtocolError(`frame payload too large: ${length} > ${MAX_PAYLOAD_LENGTH}`);
      }
      const total = FRAME_HEADER_LENGTH + length;
      if (this.buffer.length < total) break; // 半帧，等后续 chunk
      // Buffer.from 复制：帧保留期间不引用解析器内部 buffer（也规避 Buffer 泛型差异）
      frames.push({ ...header, payload: Buffer.from(this.buffer.subarray(FRAME_HEADER_LENGTH, total)) });
      this.buffer = this.buffer.subarray(total);
    }
    return frames;
  }
}

/** JSON payload 编解码辅助。 */
export function jsonPayload(obj: unknown): Buffer {
  return Buffer.from(JSON.stringify(obj), "utf8");
}

export function parseJsonPayload(frame: Frame): Record<string, unknown> {
  const raw = frame.payload.toString("utf8");
  const parsed = JSON.parse(raw) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ProtocolError("payload is not a JSON object");
  }
  return parsed as Record<string, unknown>;
}

/** OPEN 帧 payload：客户端请求（hub → gateway）。 */
export interface RequestOpen {
  kind: "http" | "ws" | "raw";
  method?: string;
  path?: string;
  headers?: Record<string, string | string[]>;
}

/** OPEN 帧 payload：上游响应（gateway → hub）。 */
export interface ResponseOpen {
  kind: "http";
  status?: number;
  reason?: string;
  headers?: Record<string, string | string[]>;
}

export function isRequestOpen(p: unknown): p is RequestOpen {
  const kind = (p as Record<string, unknown> | null)?.kind;
  return typeof p === "object" && p !== null && (kind === "http" || kind === "ws" || kind === "raw");
}

export function isResponseOpen(p: unknown): p is ResponseOpen {
  return typeof p === "object" && p !== null && (p as Record<string, unknown>).kind === "http" && typeof (p as Record<string, unknown>).status === "number";
}
