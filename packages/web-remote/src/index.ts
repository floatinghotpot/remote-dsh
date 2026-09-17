/**
 * dsh-web-remote — server half (Cordis function plugin, runs in the dsh web process).
 *
 * Runs the join tunnel in-process (no spawn), forwarding to the local dsh web
 * (`127.0.0.1:<webServer.port>`), and exposes the `/remote-access` RPC channel
 * (`connect` / `disconnect` / `revoke` / `state`) to the browser client half.
 *
 * The channel is a native prefix route on the web server (see `./rpc-route.ts`),
 * not `connection.rpc.handle(...)`: since 0.1.5-rc.2 that helper reads
 * `owner.webServer` through a service shadow whose fiber cannot resolve
 * `webServer` for third-party plugins and aborts the whole plugin tree
 * (upstream regression, deepseek-harness discussion #5926).
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
  exchangeDshSessionCookie,
  DEFAULT_HOST_CONFIG_PATH,
} from "rdsh-gateway";
import type { JoinHandle, JoinState, RdshConfig } from "rdsh-gateway";
import { RPC_CHANNEL, handleRpcRoute } from "./rpc-route.ts";
import type { ConnectionService, RpcDispatch, RpcResult, WebServerService } from "./rpc-route.ts";

/** 面板状态（client 半 §2 五态 + 断开后态） */
export type Status = "unconfigured" | "disconnected" | "connecting" | "connected" | "reconnecting" | "external";

interface Ctx {
  connection: ConnectionService;
  webServer: WebServerService;
  effect(callback: () => unknown, label: string): void;
  on(event: string, cb: () => void): void;
  /**
   * 读取服务而不建立硬依赖（缺席返回 undefined）。用于取 `directoryPicker`
   * 做只读诊断——本插件不 inject 它，避免没有选择器的组合把插件树拖垮。
   */
  get(name: string): unknown;
}

/** `directoryPicker` 服务的最小形状（只读 kind，避免依赖上游类型包）。 */
interface DirectoryPickerLike {
  capability?: () => { kind?: string } | undefined;
}

/** 本部署期望的选择器形态：插件就是为远程访问而生，必须是浏览器内形态。 */
const EXPECTED_PICKER_KIND = "browse";

/** 当前解析出的选择器形态（`browse` / `native` / `none` / `unknown`）——只读诊断，不参与业务。 */
function pickerKindOf(ctx: { get(name: string): unknown }): string {
  try {
    const kind = (ctx.get("directoryPicker") as DirectoryPickerLike | undefined)?.capability?.()?.kind;
    return typeof kind === "string" ? kind : "none";
  } catch {
    return "unknown";
  }
}

/**
 * 面板用的目录选择器诊断（纯函数，便于单测）。
 * `pickerOk === false` 是远端访问的**故障信号**：说明选择器不是浏览器内形态，
 * 远端浏览器只会看到弹在宿主屏幕上的原生对话框。
 */
export function pickerDiagnostics(ctx: { get(name: string): unknown }): {
  pickerKind: string;
  expectedPickerKind: string;
  pickerOk: boolean;
} {
  const pickerKind = pickerKindOf(ctx);
  return { pickerKind, expectedPickerKind: EXPECTED_PICKER_KIND, pickerOk: pickerKind === EXPECTED_PICKER_KIND };
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
  let liveAccessCode: string | null | undefined; // 运行中切换的访问密码（undefined=未初始化；null=关闭）
  let currentConfig: RdshConfig | null = null; // 最近一次读到的 host.json
  let dshAuthCookieHeader: string | null = null; // 0.1.2+ 进程内换发的 dsh 会话 cookie

  // 0.1.2+ 进程内换发：能力探测 authenticatedUrl → 换发浏览器会话 cookie（0.1.1 无此方法 → 跳过）
  const authConn = ctx.connection;
  if (typeof authConn.authenticatedUrl === "function") {
    void (async () => {
      try {
        const url = authConn.authenticatedUrl!(`http://127.0.0.1:${ctx.webServer.port}`);
        const token = new URL(url).searchParams.get("token");
        if (token !== null) {
          dshAuthCookieHeader = await exchangeDshSessionCookie(ctx.webServer.port, token);
          if (dshAuthCookieHeader === null) {
            lastMessage = "dsh 0.1.2 认证换发失败，远程访问将不可用";
          }
        }
      } catch {
        /* 能力探测失败静默：0.1.1 无认证，无需 cookie */
      }
    })();
  }

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
    liveAccessCode = config.gateway?.accessCode ?? null;
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
      gateway: config.gateway,
      dshAuthCookieHeader,
      name,
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
    } catch (e) {
      // 自动接入失败不阻塞面板；用户可手动接入重试。
      // 例外：锁被占用（同机另一实例在跑隧道）必须让用户看见原因 —— 否则表现为
      // 「面板一直 disconnected」，与修复前的「状态反复掉线/连线」一样无法自查。
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("join lock") || msg.includes("another tunnel is already running")) lastMessage = msg;
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
      // 只读诊断：每个分支都带上，面板据此显示/告警当前目录选择器形态
      const picker = pickerDiagnostics(ctx);
      if (handle !== null && liveState !== null) {
        return ok({
          status: mapState(liveState),
          hub: currentHub,
          name: currentName,
          message: lastMessage,
          hasToken: true,
          uiCompat: compat,
          hasAccessCode: accessCodeEnabled(),
          ...picker,
        });
      }
      const held = readJoinLock();
      if (held !== null && held.role === "cli") {
        return ok({ status: "external", uiCompat: compat, hasAccessCode: accessCodeEnabled(), ...picker });
      }
      const config = await loadConfig(DEFAULT_HOST_CONFIG_PATH);
      const hasAccessCode = config.gateway?.accessCode != null;
      if (config.mode === "join" && config.hub !== undefined) {
        return ok({
          status: "disconnected",
          hub: config.hub,
          name: config.name,
          message: lastMessage,
          hasToken: readPersistedToken(config.hub) !== null,
          uiCompat: compat,
          hasAccessCode,
          ...picker,
        });
      }
      return ok({ status: "unconfigured", uiCompat: compat, hasAccessCode, ...picker });
    } catch (e) {
      return err("internal", e instanceof Error ? e.message : String(e));
    }
  }

  /** 读当前 dshUiCompat 开关（内存覆盖 > host.json；缺省 true）。 */
  function uiCompatEnabled(): boolean {
    if (liveCompat !== undefined) return liveCompat;
    return currentConfig?.dshUiCompat?.trustE2EEAsLoopback !== false;
  }

  /** 当前访问密码是否启用（运行中 live 优先；否则读最近 host.json；缺省 false）。 */
  function accessCodeEnabled(): boolean {
    if (liveAccessCode !== undefined) return liveAccessCode !== null;
    return currentConfig?.gateway?.accessCode != null;
  }

  async function setAccessCode(args: Record<string, unknown>): Promise<RpcResult> {
    try {
      const raw = args.code;
      // null/undefined = 清除；否则必须是 ≥4 的非空字符串
      let code: string | null;
      if (raw === null || raw === undefined) {
        code = null;
      } else if (typeof raw === "string" && raw.length >= 4) {
        code = raw;
      } else {
        return err("bad-request", "code must be null or a string of at least 4 chars");
      }
      // ① 内存即时生效（运行中的隧道；缺省也写入供下次连接）
      liveAccessCode = code;
      handle?.setAccessCode(code);
      // ② 持久化 host.json
      const config = await loadConfig(DEFAULT_HOST_CONFIG_PATH);
      config.gateway = { accessCode: code };
      await saveConfig(DEFAULT_HOST_CONFIG_PATH, config);
      currentConfig = config;
      return ok({ hasAccessCode: code !== null });
    } catch (e) {
      return err("internal", e instanceof Error ? e.message : String(e));
    }
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

  /** Business dispatch of the browser half's channel; the envelope is handled by `handleRpcRoute`. */
  const dispatch: RpcDispatch = async (endpoint, payload) => {
    const args = payload.args ?? {};
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
      case "set-access-code":
        return await setAccessCode(args);
      default:
        return err("bad-request", `unknown endpoint ${endpoint}`);
    }
  };

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: "prefix",
        path: RPC_CHANNEL,
        handler: (req, res) => void handleRpcRoute(ctx.connection, req, res, dispatch),
      }),
    `dsh-web-remote: ${RPC_CHANNEL} RPC route`,
  );

  // 启动自动接入（静默；CLI 托管时跳过，见 autoConnect 前置条件）
  void autoConnect();

  ctx.on("dispose", () => {
    void handle?.stop();
  });
}
