/**
 * tunnel.ts — hub 侧隧道：注册表 + 连接帧处理（协议 PROTOCOL.md v1）。
 *
 * streamId 由 hub 分配（原子递增），gateway 在响应流中原样回显。
 * 在线状态：注册/摘除 → events.ts 推送。
 */
import type { WebSocket } from "ws";
import { FrameParser, FRAME_TYPE, jsonPayload, parseJsonPayload, encodeFrame, FLAG_E2E } from "rdsh-tunnel";
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

/** 心跳间隔与死线上限（协议 PROTOCOL.md「心跳与重连」；双方对称维护）。 */
const HEARTBEAT_MS = 30_000;
const PONG_TIMEOUT_MS = 10_000;

/** 心跳时序（测试可注入毫秒级小值）。 */
export interface TunnelTimings {
  heartbeatMs?: number;
  pongTimeoutMs?: number;
}

export class TunnelConn {
  readonly hostId: string;
  private readonly ws: WebSocket;
  private readonly parser = new FrameParser();
  private nextStreamId = 1;
  private readonly streams = new Map<number, StreamHandler>();
  private heartbeat: NodeJS.Timeout | undefined;
  /** 发出 PING 后的存活死线：期间收到**任何**入站帧即撤销。 */
  private livenessDeadline: NodeJS.Timeout | undefined;

  constructor(ws: WebSocket, hostId: string, onClose: (hostId: string) => void, timings: TunnelTimings = {}) {
    this.ws = ws;
    this.hostId = hostId;
    const heartbeatMs = timings.heartbeatMs ?? HEARTBEAT_MS;
    const pongTimeoutMs = timings.pongTimeoutMs ?? PONG_TIMEOUT_MS;
    ws.on("message", (data, isBinary) => this.onMessage(data, isBinary));
    ws.on("close", () => {
      this.stopHeartbeat();
      onClose(hostId);
    });
    ws.on("error", () => {
      this.stopHeartbeat();
      onClose(hostId);
    });
    // hub 侧也主动发 PING（对称心跳）：发出后 pongTimeoutMs 内收不到任何帧
    // 即判连接已死 → terminate → close → onClose（摘除注册表 + 推送 host.offline）。
    this.heartbeat = setInterval(() => {
      if (this.ws.readyState !== this.ws.OPEN) return;
      this.send(FRAME_TYPE.PING, 0, jsonPayload({ ts: Date.now() }));
      // 只在**没有未决死线**时武装：上一发 PING 仍未获任何回应时，原死线继续计时（不重置），
      // 否则当 heartbeatMs < pongTimeoutMs 时死线会被每个周期无限推迟（永不判死）。
      if (this.livenessDeadline === undefined) {
        this.livenessDeadline = setTimeout(() => {
          this.livenessDeadline = undefined;
          this.terminate();
        }, pongTimeoutMs);
        this.livenessDeadline.unref?.();
      }
    }, heartbeatMs);
    this.heartbeat.unref?.();
  }

  /** 停止心跳与死线定时器（连接关闭/出错时；避免定时器泄漏并让进程可退出）。 */
  private stopHeartbeat(): void {
    if (this.heartbeat !== undefined) {
      clearInterval(this.heartbeat);
      this.heartbeat = undefined;
    }
    if (this.livenessDeadline !== undefined) {
      clearTimeout(this.livenessDeadline);
      this.livenessDeadline = undefined;
    }
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

  /** 打开一个 E2EE raw 流（Noise 握手 + 密文字节，hub 不解析内容）。 */
  openRawStream(handler: StreamHandler): number {
    const streamId = this.assignStreamId();
    this.streams.set(streamId, handler);
    this.send(FRAME_TYPE.OPEN, streamId, jsonPayload({ kind: "raw" }), FLAG_E2E);
    return streamId;
  }

  /** 发送 raw 流字节（E2E 帧标记）。 */
  sendRawData(streamId: number, chunk: Buffer): void {
    this.send(FRAME_TYPE.DATA, streamId, chunk, FLAG_E2E);
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

  send(type: number, streamId: number, payload: Buffer | string, flags = 0): void {
    if (this.ws.readyState === this.ws.OPEN) {
      this.ws.send(encodeFrame(type, streamId, payload, flags));
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
    // 任何入站帧都是存活证据 → 撤销死线（不限于 PONG）
    if (this.livenessDeadline !== undefined) {
      clearTimeout(this.livenessDeadline);
      this.livenessDeadline = undefined;
    }
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
        return; // 存活证据已由 onMessage 撤销死线（双方对称维护超时，见 PROTOCOL.md）
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

  /**
   * 摘除隧道。传 `conn` 时做**身份校验**：仅当注册表当前持有的正是该连接才摘除。
   *
   * 必要性：重连时 `register` 会 terminate 旧连接，而旧连接的 close 回调**晚于**
   * 新连接注册才触发；若无条件 delete，会把刚接手的新连接一起摘掉 —— 表现为
   * host 假离线（门户显示离线、`relay` 取不到 conn → 503），且新隧道其实活着。
   *
   * @returns 是否真的摘除了（false = 已被新连接接管，或本就未注册）
   */
  unregister(hostId: string, conn?: TunnelConn): boolean {
    const current = this.tunnels.get(hostId);
    if (current === undefined) return false;
    if (conn !== undefined && current !== conn) return false;
    this.tunnels.delete(hostId);
    return true;
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
