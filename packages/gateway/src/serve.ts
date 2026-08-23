/**
 * serve.ts — `rdsh serve` 编排：加载 config（CLI 覆盖）→ 解析 TLS → 启动网关 → 生命周期。
 */
import { networkInterfaces } from "node:os";
import type { NetworkInterfaceInfo } from "node:os";
import { startGateway } from "./server.ts";
import type { RunningGateway } from "./server.ts";
import { findDsh, spawnDsh } from "./spawn-dsh.ts";
import { loadConfig, resolveConfigPath } from "./config.ts";
import type { RdshConfig } from "./config.ts";
import { UserManager } from "./auth.ts";
import { loadTls } from "./tls.ts";

export interface ServeOptions {
  host?: string;
  port?: number;
  pairCode?: string;
  sessionTtlSeconds?: number;
  dshPath?: string;
  reset?: boolean;
  noCode?: boolean;
  /** 配置文件路径（--config / $RDSH_CONFIG / 默认 ~/.rdsh/config.json） */
  configPath?: string;
}

/**
 * 启动网关。进程常驻：SIGINT/SIGTERM/SIGHUP 时先关网关再终止 dsh 子进程。
 * 启动失败（dsh 缺失/TLS 缺失/端口占用/安全约束）→ 抛错（CLI 以非零码退出）。
 */
export async function serve(opts: ServeOptions): Promise<void> {
  const configPath = resolveConfigPath(opts.configPath);
  const config: RdshConfig = await loadConfig(configPath);

  // CLI 参数优先于 config（持久配置在 config，CLI 做临时覆盖/调试）
  const host = opts.host ?? config.host;
  const port = opts.port ?? config.port;
  const sessionTtlSeconds = opts.sessionTtlSeconds ?? config.sessionTtlSeconds;
  const dshPath = opts.dshPath ?? config.dshPath;
  const authMode = opts.noCode ? "none" : config.auth.mode;
  const pairCode = opts.pairCode ?? config.auth.pairCode;

  const foundDsh = findDsh(dshPath);
  if (foundDsh === null) {
    throw new Error("cannot find 'dsh' in PATH. Install DeepSeek Harness first, or set dshPath in config / pass --dsh <path>.");
  }

  const dsh = await spawnDsh(foundDsh);

  // TLS 决策：有 tls.cert/key → https；无 → http（behindProxy 或 pair/none）。
  // password + http + 非反代 → server.ts 安全约束拒绝启动（需自行提供证书）。
  const tlsMaterial = await loadTls(config.tls, config.behindProxy);
  const userManager = authMode === "password" ? new UserManager(configPath) : undefined;

  if (opts.noCode || authMode === "none") {
    console.warn(
      "\n⚠  rdsh: 认证已禁用（auth.mode=none / --no-code）—— 任何能访问该端口的设备将直接操作 DSH！\n" +
        "     仅限完全可信网络！\n",
    );
  }

  let gateway: RunningGateway;
  try {
    gateway = await startGateway({
      host,
      port,
      pairCode,
      sessionTtlSeconds,
      dshPort: dsh.port,
      reset: opts.reset,
      noCode: opts.noCode,
      authMode,
      authVersion: config.auth.version,
      allowFrom: config.allowFrom,
      behindProxy: config.behindProxy,
      tlsMaterial,
      userManager,
      configPath,
    });
  } catch (err) {
    // 启动失败（端口占用 / 安全约束拒绝）→ 先停掉已 spawn 的 dsh，避免残留
    await dsh.stop().catch(() => undefined);
    throw err;
  }

  const lan = lanAddresses();
  const scheme = tlsMaterial === null ? "http" : "https";
  const displayHost = host === "0.0.0.0" ? (lan[0] ?? "127.0.0.1") : host;
  console.log(`rdsh serve: gateway on ${scheme}://${displayHost}:${gateway.actualPort}`);
  if (host === "0.0.0.0" && lan.length > 0) {
    console.log(`rdsh serve: LAN: ${lan.map((ip) => `${scheme}://${ip}:${gateway.actualPort}`).join(", ")}`);
  }
  console.log(`rdsh serve: dsh web on 127.0.0.1:${dsh.port}`);
  console.log(`rdsh serve: auth mode: ${authMode}${authMode === "password" ? ` (config: ${configPath})` : authMode === "pair" ? ` (pair code: ${gateway.pair.codeValue()})` : ""}`);
  if (config.allowFrom.length > 0) console.log(`rdsh serve: allow_from: ${config.allowFrom.join(", ")}`);
  if (tlsMaterial !== null) console.log(`rdsh serve: TLS: custom cert (${config.tls!.cert})`);
  if (config.behindProxy) console.log("rdsh serve: behind_proxy: true (TLS terminated by reverse proxy)");
  if (authMode === "password") console.log("rdsh serve: sign in with `rdsh user` credentials in the browser login page.");
  else if (authMode === "pair") console.log("rdsh serve: enter the pair code in the browser on your other device.");

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\nrdsh: received ${signal}, shutting down...`);
    gateway.server.close();
    let code: number;
    try {
      code = await dsh.stop();
    } catch {
      code = 1;
    }
    process.exit(code === 0 ? 0 : 1);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGHUP", () => void shutdown("SIGHUP"));
  // 常驻：进程靠信号退出（shutdown 里 process.exit）；防止函数返回后
  // CLI 的 main().then(exit) 误退出服务进程
  await new Promise<void>(() => {});
}

function lanAddresses(): string[] {
  return Object.values(networkInterfaces())
    .flat()
    .filter((i): i is NetworkInterfaceInfo => i !== undefined && i.family === "IPv4" && !i.internal)
    .map((i) => i.address);
}
