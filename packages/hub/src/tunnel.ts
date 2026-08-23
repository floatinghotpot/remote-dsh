/**
 * tunnel.ts — hub 侧隧道：注册表 + 连接帧处理（协议 PROTOCOL.md v1）。
 *
 * streamId 由 hub 分配（原子递增），gateway 在响应流中原样回显。
 * 在线状态：注册/摘除 → events.ts 推送。
 */
import type { WebSocket } from "ws";
import { FrameParser, FRAME_TYPE, jsonPayload, parseJsonPayload, encodeFrame } from "rdsh-tunnel";
import type { Frame } from "rdsh-tunnel";
import { ProtocolError } from "rdsh-tunnel";

/** 流级处理器：hub 侧一个 stream（浏览器请求/WS 升级）的隧道侧回调。 */
export interface StreamHandler {
  /** gateway 上游响应头（gateway 发 OPEN {kind:"http", status,...}）。 */
  onResponse?(status: number, reason: string | undefined, headers: Record<string, string | string[]>): void;
  /** 收到请求体分片（DATA 帧）。 */
  onData(chunk: Buffer): void;
  /** 流结束（CLOSE）。 */
  onClose(code?: number, message?: string): void;
  /** 协议错误（ERROR）。 */
  onError(code: string, message: string): void;
}

export class TunnelConn {
  readonly hostId: string;
  private readonly ws: WebSocket;
  private readonly parser = new FrameParser();
  private nextStreamId = 1;
  private readonly streams = new Map<number, StreamHandler>();

  constructor(ws: WebSocket, hostId: string, onClose: (hostId: string) => void) {
    this.ws = ws;
    this.hostId = hostId;
    ws.on("message", (data, isBinary) => this.onMessage(data, isBinary));
    ws.on("close", () => onClose(hostId));
    ws.on("error", () => onClose(hostId));
  }

  /** 分配 streamId（原子递增）。 */
  assignStreamId(): number {
    const id = this.nextStreamId;
    this.nextStreamId = (this.nextStreamId + 1) >>> 0; // uint32 环绕
    return id;
  }

  /** 打开一个客户端请求流，返回 streamId。method 仅 http 使用（ws 升级恒为 GET）。 */
  openStream(kind: "http" | "ws", path: string, method: string, headers: Record<string, string | string[]>, handler: StreamHandler): number {
    const streamId = this.assignStreamId();
    this.streams.set(streamId, handler);
    this.send(FRAME_TYPE.OPEN, streamId, jsonPayload({ kind, path, method, headers }));
    return streamId;
  }

  /** 发送请求体分片。 */
  sendData(streamId: number, chunk: Buffer): void {
    this.send(FRAME_TYPE.DATA, streamId, chunk);
  }

  /**
   * 请求体结束：发 CLOSE 通知 gateway 请求发送完毕（**不删 handler**，
   * 响应尚未回来；GET 无请求体时 req end 立即触发）。
   */
  endRequest(streamId: number): void {
    this.send(FRAME_TYPE.CLOSE, streamId, jsonPayload({ code: 0 }));
  }

  /** 客户端中断：通知 gateway 并清理流。 */
  abortStream(streamId: number): void {
    this.send(FRAME_TYPE.CLOSE, streamId, jsonPayload({ code: 1, message: "client aborted" }));
    this.streams.delete(streamId);
  }

  send(type: number, streamId: number, payload: Buffer | string): void {
    if (this.ws.readyState === this.ws.OPEN) {
      this.ws.send(encodeFrame(type, streamId, payload));
    }
  }

  terminate(): void {
    try {
      this.ws.terminate();
    } catch {
      /* 已关闭 */
    }
  }

  private onMessage(data: unknown, isBinary: boolean): void {
    const chunk = Array.isArray(data)
      ? Buffer.concat(data as Buffer[])
      : Buffer.isBuffer(data)
        ? (data as Buffer)
        : Buffer.from(data as string);
    if (!isBinary) {
      // 文本帧非协议内容（异常），忽略
      return;
    }
    let frames: Frame[];
    try {
      frames = this.parser.push(chunk);
    } catch (err) {
      // 协议错误（magic/版本/超长）→ 通知并断开
      this.send(FRAME_TYPE.ERROR, 0, jsonPayload({ code: "PROTOCOL", message: err instanceof Error ? err.message : "frame error" }));
      this.terminate();
      return;
    }
    for (const frame of frames) {
      this.handleFrame(frame);
    }
  }

  private handleFrame(frame: Frame): void {
    switch (frame.type) {
      case FRAME_TYPE.PING: {
        this.send(FRAME_TYPE.PONG, frame.streamId, frame.payload);
        return;
      }
      case FRAME_TYPE.PONG:
        return; // 心跳回显（gateway 侧维护超时）
      case FRAME_TYPE.OPEN: {
        // gateway 侧流开始 = 上游响应头
        const handler = this.streams.get(frame.streamId);
        if (handler?.onResponse !== undefined) {
          try {
            const p = parseJsonPayload(frame);
            const status = typeof p.status === "number" ? p.status : 502;
            const reason = typeof p.reason === "string" ? p.reason : undefined;
            const headers = typeof p.headers === "object" && p.headers !== null
              ? (p.headers as Record<string, string | string[]>)
              : {};
            handler.onResponse(status, reason, headers);
          } catch {
            handler.onError("BAD_RESPONSE", "malformed response open");
          }
        }
        return;
      }
      case FRAME_TYPE.DATA: {
        const handler = this.streams.get(frame.streamId);
        if (handler) handler.onData(frame.payload);
        return;
      }
      case FRAME_TYPE.CLOSE: {
        const handler = this.streams.get(frame.streamId);
        if (handler) {
          let code: number | undefined;
          let message: string | undefined;
          try {
            const p = parseJsonPayload(frame);
            if (typeof p.code === "number") code = p.code;
            if (typeof p.message === "string") message = p.message;
          } catch {
            /* 空 CLOSE */
          }
          this.streams.delete(frame.streamId);
          handler.onClose(code, message);
        }
        return;
      }
      case FRAME_TYPE.ERROR: {
        const handler = this.streams.get(frame.streamId);
        if (handler) {
          let code = "ERROR";
          let message = "";
          try {
            const p = parseJsonPayload(frame);
            if (typeof p.code === "string") code = p.code;
            if (typeof p.message === "string") message = p.message;
          } catch {
            /* ignore */
          }
          this.streams.delete(frame.streamId);
          handler.onError(code, message);
        }
        return;
      }
      default:
        // 未知帧类型：忽略（向前兼容）
        return;
    }
  }
}

/** 隧道注册表：hostId → 活跃连接。 */
export class TunnelRegistry {
  private readonly tunnels = new Map<string, TunnelConn>();

  /** 注册隧道；返回 conn。重复注册（重连）→ 踢掉旧连接。 */
  register(conn: TunnelConn): void {
    const existing = this.tunnels.get(conn.hostId);
    if (existing !== undefined) {
      existing.terminate();
    }
    this.tunnels.set(conn.hostId, conn);
  }

  unregister(hostId: string): void {
    this.tunnels.delete(hostId);
  }

  get(hostId: string): TunnelConn | null {
    return this.tunnels.get(hostId) ?? null;
  }

  isOnline(hostId: string): boolean {
    return this.tunnels.has(hostId);
  }

  list(): string[] {
    return [...this.tunnels.keys()];
  }
}
