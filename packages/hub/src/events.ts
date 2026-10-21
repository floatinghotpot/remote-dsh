/**
 * events.ts — WSS /api/events：登录态订阅，host 在线/离线实时推送。
 *
 * 事件格式：JSON `{type: "host.online"|"host.offline", hostId, name?}`。
 */
import type { WebSocket } from "ws";
import { WebSocketServer } from "ws";

interface EventsClient {
  ws: WebSocket;
  userId: number;
}

export class EventHub {
  private readonly clients = new Set<EventsClient>();

  /** 注册 /api/events 连接（已认证）。 */
  add(ws: WebSocket, userId: number): void {
    const client: EventsClient = { ws, userId };
    this.clients.add(client);
    ws.on("close", () => this.clients.delete(client));
    ws.on("error", () => this.clients.delete(client));
  }

  /** 推送事件给指定用户（host 归属 owner）。 */
  pushToUser(userId: number, event: { type: string; hostId: string; name?: string }): void {
    const msg = JSON.stringify(event);
    for (const client of this.clients) {
      if (client.userId === userId && client.ws.readyState === client.ws.OPEN) {
        client.ws.send(msg);
      }
    }
  }

  /** 当前订阅数（测试用）。 */
  size(): number {
    return this.clients.size;
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
