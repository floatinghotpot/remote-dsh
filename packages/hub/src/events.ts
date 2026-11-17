/**
 * events.ts — WSS /api/events：登录态订阅，host 在线/离线实时推送。
 *
 * 事件格式：JSON `{type: "host.online"|"host.offline", hostId, name?}`。
 * 心跳（70 A3）：服务端每 25s 发 `{"type":"ping"}`；客户端回 `{"type":"pong"}`；
 * 60s 收不到 pong → 判死并 close（避免反代静默掐断后留下半死连接）。
 * 索引（70 A2）：按 userId 分桶，广播 O(该用户订阅数)，与订阅总数无关。
 */
import type { WebSocket } from "ws";
import { WebSocketServer } from "ws";

/** 服务端 ping 间隔（ms）。 */
export const EVENTS_HEARTBEAT_MS = 25_000;
/** 超过该时长未收到 pong 判死（ms）。 */
export const EVENTS_DEAD_MS = 60_000;

interface EventsClient {
  ws: WebSocket;
  userId: number;
  /** 最近一次收到 pong 的时间（ms）。 */
  lastPongAt: number;
  timer: NodeJS.Timeout | undefined;
}

export class EventHub {
  /** 按 userId 索引订阅者（70 A2）。 */
  private readonly byUser = new Map<number, Set<EventsClient>>();
  /** 订阅总数（O(1) 维护，供健康页/测试读取，避免 size() 每次 O(distinct userId)）。 */
  private count = 0;

  /** 注册 /api/events 连接（已认证）。 */
  add(ws: WebSocket, userId: number): void {
    const client: EventsClient = { ws, userId, lastPongAt: Date.now(), timer: undefined };
    let bucket = this.byUser.get(userId);
    if (bucket === undefined) {
      bucket = new Set();
      this.byUser.set(userId, bucket);
    }
    bucket.add(client);
    this.count += 1;

    client.timer = setInterval(() => {
      if (ws.readyState !== ws.OPEN) return;
      if (Date.now() - client.lastPongAt > EVENTS_DEAD_MS) {
        ws.close(4408, "pong timeout");
        return;
      }
      try {
        ws.send(JSON.stringify({ type: "ping" }));
      } catch {
        /* 发送失败：close/error 事件会清理 */
      }
    }, EVENTS_HEARTBEAT_MS);
    client.timer.unref?.();

    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(String(data)) as { type?: unknown };
        if (msg.type === "pong") client.lastPongAt = Date.now();
      } catch {
        /* 忽略坏帧 */
      }
    });
    ws.on("close", () => this.remove(client));
    ws.on("error", () => this.remove(client));
  }

  private remove(client: EventsClient): void {
    if (client.timer !== undefined) {
      clearInterval(client.timer);
      client.timer = undefined;
    }
    const bucket = this.byUser.get(client.userId);
    if (bucket === undefined) return;
    if (bucket.delete(client)) this.count -= 1;
    if (bucket.size === 0) this.byUser.delete(client.userId);
  }

  /**
   * 关闭某用户的所有订阅（封号/删除时调用，A3 §7「鉴权只在 upgrade 一次」的缓解）。
   * close 事件会触发 remove 并递减计数；这里只发 close，不直接删，避免重复计数。
   */
  closeUser(userId: number): void {
    const bucket = this.byUser.get(userId);
    if (bucket === undefined) return;
    for (const client of [...bucket]) client.ws.close(4401, "account revoked");
  }

  /** 推送事件给指定用户（host 归属 owner）。 */
  pushToUser(userId: number, event: { type: string; hostId: string; name?: string }): void {
    const bucket = this.byUser.get(userId);
    if (bucket === undefined) return;
    const msg = JSON.stringify(event);
    for (const client of bucket) {
      if (client.ws.readyState === client.ws.OPEN) {
        client.ws.send(msg);
      }
    }
  }

  /** 当前订阅数。 */
  size(): number {
    return this.count;
  }
}

/** 独立 WSS 服务器（noServer，由 hub server 的 upgrade 分流）。 */
export function createEventsServer(events: EventHub): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });
  wss.on("connection", (ws) => {
    const userId = (ws as WebSocket & { rdshUserId?: number }).rdshUserId;
    if (userId === undefined) {
      ws.close(4401, "unauthorized");
      return;
    }
    events.add(ws, userId);
  });
  return wss;
}
