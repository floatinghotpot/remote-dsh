/**
 * serve.ts — `rdsh serve` 编排：spawn dsh → 启动网关 → 打印启动信息 → 生命周期。
 */
import { networkInterfaces } from "node:os";
import type { NetworkInterfaceInfo } from "node:os";
import { startGateway } from "./server.ts";
import { findDsh, spawnDsh } from "./spawn-dsh.ts";

export interface ServeOptions {
  host: string;
  port: number;
  pairCode?: string;
  sessionTtlSeconds: number;
  dshPath?: string;
  reset?: boolean;
  /** true = 跳过配对码认证（仅限完全可信网络！打印警告） */
  noCode?: boolean;
}

/**
 * 启动 LAN 认证网关。进程常驻：SIGINT/SIGTERM 时先关网关再终止 dsh 子进程。
 * 启动失败（dsh 缺失/启动失败/端口占用）→ 抛错（CLI 负责以非零码退出）。
 */
export async function serve(opts: ServeOptions): Promise<void> {
  const dshPath = findDsh(opts.dshPath);
  if (dshPath === null) {
    throw new Error(
      "cannot find 'dsh' in PATH. Install DeepSeek Harness first, or pass --dsh <path>.",
    );
  }

  const dsh = await spawnDsh(dshPath);
  if (opts.noCode) {
    console.warn(
      "\n⚠  rdsh: --no-code 已启用 —— 跳过配对码认证！\n" +
        "     任何能访问该端口的设备都将直接操作 DSH（可执行任意命令）。\n" +
        "     仅限完全可信的局域网（家庭/公司内网）使用！\n",
    );
  }
  const gateway = await startGateway({
    host: opts.host,
    port: opts.port,
    pairCode: opts.pairCode,
    sessionTtlSeconds: opts.sessionTtlSeconds,
    dshPort: dsh.port,
    reset: opts.reset,
    noCode: opts.noCode,
  });

  const lan = lanAddresses();
  const displayHost = opts.host === "0.0.0.0" ? (lan[0] ?? "127.0.0.1") : opts.host;
  console.log(`rdsh serve: gateway on http://${displayHost}:${gateway.actualPort}`);
  if (opts.host === "0.0.0.0" && lan.length > 0) {
    console.log(`rdsh serve: LAN: ${lan.map((ip) => `http://${ip}:${gateway.actualPort}`).join(", ")}`);
  }
  console.log(`rdsh serve: dsh web on 127.0.0.1:${dsh.port}`);
  console.log(`rdsh serve: pair code: ${gateway.pair.codeValue()}`);
  console.log("rdsh serve: enter the pair code in the browser on your other device.");

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return; // 幂等：重复信号不再处理
    shuttingDown = true;
    console.log(`\nrdsh: received ${signal}, shutting down...`);
    // 停止接受新连接；残留活跃连接由进程退出时由 OS 清理
    gateway.server.close();
    let code: number;
    try {
      code = await dsh.stop();
    } catch {
      code = 1;
    }
    // 必须显式退出：仅设 exitCode 会因残留句柄（信号监听器/管道）而挂住
    process.exit(code === 0 ? 0 : 1);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  // 覆盖默认行为：SIGHUP（关终端/断 SSH）也优雅清理，避免 dsh 子进程成为孤儿
  process.on("SIGHUP", () => void shutdown("SIGHUP"));
}

function lanAddresses(): string[] {
  return Object.values(networkInterfaces())
    .flat()
    .filter((i): i is NetworkInterfaceInfo => i !== undefined && i.family === "IPv4" && !i.internal)
    .map((i) => i.address);
}
