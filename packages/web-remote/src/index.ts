/**
 * dsh-web-remote — server half (Cordis function plugin, runs in the dsh web process).
 *
 * Runs the join tunnel in-process (no spawn), forwarding to the local dsh web
 * (`127.0.0.1:<webServer.port>`), and exposes the `/remote-access` RPC channel
 * (`connect` / `disconnect` / `revoke` / `state`) to the browser client half.
 *
 * Function-plugin form (export `inject` + `apply`) — no `@deepseek-ai/cordis`
 * runtime import, only a minimal local `Ctx` type.
 */
import { existsSync } from "node:fs";
import {
  registerJoin,
  startJoin,
  selfRevoke,
  clearPersistedToken,
  readPersistedToken,
  readJoinLock,
  loadConfig,
  saveConfig,
  DEFAULT_HOST_CONFIG_PATH,
} from "rdsh-gateway";
import type { JoinHandle, JoinState, RdshConfig } from "rdsh-gateway";

/** 面板状态（client 半 §2 五态 + 断开后态） */
export type Status = "unconfigured" | "disconnected" | "connecting" | "connected" | "reconnecting" | "external";

type RpcResult = { ok: true; value: unknown } | { ok: false; error: { code: string; message: string; details?: unknown } };

interface RpcHandler {
  handle(
    channel: string,
    handler: (endpoint: string, payload: { args?: Record<string, unknown> }, signal: AbortSignal) => Promise<RpcResult>,
    options?: { authority?: string },
  ): void;
}

interface Ctx {
  connection: { rpc: RpcHandler };
  webServer: { port: number };
  on(event: string, cb: () => void): void;
}

const ok = (value: unknown): RpcResult => ({ ok: true, value });
const err = (code: string, message: string): RpcResult => ({ ok: false, error: { code, message, details: {} } });

function mapState(s: JoinState): Status {
  switch (s) {
    case "connecting":
      return "connecting";
    case "connected":
      return "connected";
    case "reconnecting":
      return "reconnecting";
    case "rejected":
    case "stopped":
      return "disconnected";
  }
}

export const inject = ["connection", "webServer"];

export function apply(ctx: Ctx): void {
  let handle: JoinHandle | null = null;
  let liveState: JoinState | null = null; // 仅隧道运行中非 null
  let currentHub: string | undefined;
  let currentName: string | undefined;
  let lastMessage: string | undefined;
  let liveCompat: boolean | undefined; // 运行中切换的 dshUiCompat（覆盖 host.json）
  let currentConfig: RdshConfig | null = null; // 最近一次读到的 host.json

  const hooks = {
    onState: (s: JoinState, detail?: { message?: string; delayMs?: number }): void => {
      liveState = s;
      if (s === "rejected") {
        // 永久失败（token 吊销）→ 记录原因并停，不重连
        lastMessage = detail?.message ?? "host token rejected by hub";
        handle = null;
        liveState = null;
      } else if (s === "stopped") {
        handle = null;
        liveState = null;
      } else if (s === "connected") {
        // 已连接 → 清掉「connecting…」之类的过渡信息
        lastMessage = undefined;
      }
    },
    onLog: (level: "info" | "warn" | "error", message: string): void => {
      // MVP：日志不渲染，仅记录错误供面板 message 展示
      if (level === "error") lastMessage = message;
    },
  };

  /** 读 host.json 非 join 模式是否需确认覆盖（D5 档1：host.json 存在且 mode≠join）。 */
  async function needsOverwriteConfirm(): Promise<boolean> {
    if (!existsSync(DEFAULT_HOST_CONFIG_PATH)) return false;
    const config = await loadConfig(DEFAULT_HOST_CONFIG_PATH);
    return config.mode !== "join";
  }

  async function connect(args: Record<string, unknown>): Promise<RpcResult> {
    try {
      if (typeof args.hub !== "string" || args.hub.trim() === "") {
        return err("bad-request", "hub (string) required");
      }
      const hub = args.hub.trim();
      if (!/^https?:\/\//.test(hub)) return err("bad-request", "hub must be an http(s) URL");
      const token = typeof args.token === "string" && args.token.trim() !== "" ? args.token.trim() : undefined;
      const name = typeof args.name === "string" && args.name.trim() !== "" ? args.name.trim() : undefined;

      // 已在跑 → 幂等返回当前态
      if (handle !== null) {
        return ok({ status: mapState(liveState ?? "connected"), hub: currentHub, name: currentName });
      }

      // D5 档2：CLI 持有隧道 → 拒绝
      const held = readJoinLock();
      if (held !== null && held.role === "cli") {
        return err("lock-busy", `join tunnel is owned by the rdsh CLI (pid ${held.pid}); stop it first`);
      }

      // D5 档1：覆盖 lan/cloud 配置需显式确认
      if ((await needsOverwriteConfirm()) && args.confirmOverwrite !== true) {
        return err("mode-conflict", "host.json is not in join mode; re-send with confirmOverwrite: true to overwrite");
      }

      // 注册（join token → host token）或复用持久化 host token；留空 = 复用
      const { token: hostToken, insecure, name: joinedName } = await registerJoin({ hubUrl: hub, token, name });

      // 写 host.json（mode join）
      const config = await loadConfig(DEFAULT_HOST_CONFIG_PATH);
      config.mode = "join";
      config.hub = hub;
      config.name = joinedName;
      config.insecure = insecure;
      await saveConfig(DEFAULT_HOST_CONFIG_PATH, config);

      // 起隧道：转发到本进程 dsh
      startTunnel(config, hub, hostToken, joinedName, insecure);
      return ok({ status: "connecting", hub, name });
    } catch (e) {
      return err("register-failed", e instanceof Error ? e.message : String(e));
    }
  }

  /** 起隧道并同步面板状态（connect / autoConnect 共用；转发到本进程 dsh）。 */
  function startTunnel(config: RdshConfig, hub: string, token: string, name: string, insecure: boolean): void {
    currentConfig = config;
    liveCompat = config.dshUiCompat?.trustE2EEAsLoopback !== false;
    currentHub = hub;
    currentName = name;
    lastMessage = undefined;
    handle = startJoin({
      hubUrl: hub,
      token,
      insecure,
      target: { host: "127.0.0.1", port: ctx.webServer.port },
      role: "plugin",
      dshUiCompat: config.dshUiCompat,
      hooks,
    });
  }

  /**
   * 启动时自动接入：host.json 已是 join 模式且有持久化 host token、隧道未被 CLI/他人持有 →
   * 复用 token 自动建隧道（与 CLI `rdsh host serve` 行为一致，消除「需先点接入才有隧道」的鸡生蛋）。
   * 任一前置条件不满足则静默跳过，面板保持 disconnected，由用户手动接入。
   */
  async function autoConnect(): Promise<void> {
    try {
      if (handle !== null) return;
      const held = readJoinLock();
      if (held !== null && held.role === "cli") return;
      const config = await loadConfig(DEFAULT_HOST_CONFIG_PATH);
      if (config.mode !== "join" || typeof config.hub !== "string" || config.hub === "") return;
      if (readPersistedToken(config.hub) === null) return;
      const { token: hostToken, insecure, name: joinedName } = await registerJoin({
        hubUrl: config.hub,
        name: config.name,
      });
      startTunnel(config, config.hub, hostToken, joinedName, insecure);
    } catch {
      // 自动接入失败不阻塞面板；用户可手动接入重试
    }
  }

  async function disconnect(): Promise<RpcResult> {
    if (handle !== null) {
      await handle.stop();
      handle = null;
      liveState = null;
    }
    return ok({ status: "disconnected", hub: currentHub, name: currentName });
  }

  async function revoke(): Promise<RpcResult> {
    try {
      if (handle !== null) {
        await handle.stop();
        handle = null;
        liveState = null;
      }
      const config = await loadConfig(DEFAULT_HOST_CONFIG_PATH);
      if (config.mode === "join" && config.hub !== undefined) {
        const token = readPersistedToken(config.hub);
        if (token !== null) {
          await selfRevoke(config.hub, token, config.insecure === true);
        }
        clearPersistedToken(config.hub);
      }
      const fresh: RdshConfig = await loadConfig(DEFAULT_HOST_CONFIG_PATH);
      fresh.mode = "lan";
      fresh.hub = undefined;
      fresh.name = undefined;
      fresh.insecure = undefined;
      await saveConfig(DEFAULT_HOST_CONFIG_PATH, fresh);
      currentHub = undefined;
      currentName = undefined;
      lastMessage = undefined;
      return ok({ status: "unconfigured" });
    } catch (e) {
      return err("revoke-failed", e instanceof Error ? e.message : String(e));
    }
  }

  async function state(): Promise<RpcResult> {
    try {
      const compat = uiCompatEnabled();
      if (handle !== null && liveState !== null) {
        return ok({ status: mapState(liveState), hub: currentHub, name: currentName, message: lastMessage, hasToken: true, uiCompat: compat });
      }
      const held = readJoinLock();
      if (held !== null && held.role === "cli") {
        return ok({ status: "external", uiCompat: compat });
      }
      const config = await loadConfig(DEFAULT_HOST_CONFIG_PATH);
      if (config.mode === "join" && config.hub !== undefined) {
        return ok({
          status: "disconnected",
          hub: config.hub,
          name: config.name,
          message: lastMessage,
          hasToken: readPersistedToken(config.hub) !== null,
          uiCompat: compat,
        });
      }
      return ok({ status: "unconfigured", uiCompat: compat });
    } catch (e) {
      return err("internal", e instanceof Error ? e.message : String(e));
    }
  }

  /** 读当前 dshUiCompat 开关（内存覆盖 > host.json；缺省 true）。 */
  function uiCompatEnabled(): boolean {
    if (liveCompat !== undefined) return liveCompat;
    return currentConfig?.dshUiCompat?.trustE2EEAsLoopback !== false;
  }

  async function setUiCompat(args: Record<string, unknown>): Promise<RpcResult> {
    try {
      if (typeof args.enabled !== "boolean") return err("bad-request", "enabled (boolean) required");
      // ① 内存即时生效（运行中的隧道；缺省也写入供下次连接）
      liveCompat = args.enabled;
      handle?.setUiCompat(args.enabled);
      // ② 持久化 host.json
      const config = await loadConfig(DEFAULT_HOST_CONFIG_PATH);
      config.dshUiCompat = { trustE2EEAsLoopback: args.enabled };
      await saveConfig(DEFAULT_HOST_CONFIG_PATH, config);
      currentConfig = config;
      return ok({ enabled: args.enabled });
    } catch (e) {
      return err("internal", e instanceof Error ? e.message : String(e));
    }
  }

  ctx.connection.rpc.handle(
    "/remote-access",
    async (endpoint, payload, _signal) => {
      const args = payload?.args ?? {};
      switch (endpoint) {
        case "connect":
          return await connect(args);
        case "disconnect":
          return await disconnect();
        case "revoke":
          return await revoke();
        case "state":
          return await state();
        case "set-ui-compat":
          return await setUiCompat(args);
        default:
          return err("bad-request", `unknown endpoint ${endpoint}`);
      }
    },
    { authority: "loopback" },
  );

  // 启动自动接入（静默；CLI 托管时跳过，见 autoConnect 前置条件）
  void autoConnect();

  ctx.on("dispose", () => {
    void handle?.stop();
  });
}
