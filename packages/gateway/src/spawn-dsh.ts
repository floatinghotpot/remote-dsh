/**
 * spawn-dsh.ts — 发现并启动 dsh web，解析其实际监听端口。
 *
 * 事实依据（discussion.md §2）：`dsh web --port 0 --no-open` 由 OS 分配端口，
 * 启动时打印 `dsh web: http://127.0.0.1:<port>`（dsh-web-app/lib/index.js）。
 */
import { spawn } from "node:child_process";
import { accessSync } from "node:fs";
import { createInterface } from "node:readline";
import type { ChildProcess } from "node:child_process";

/** dsh 的 URL 行格式（`dsh web: http://127.0.0.1:<port> (LAN: ...)`）。 */
const URL_LINE_RE = /dsh web:\s*http:\/\/127\.0\.0\.1:(\d+)/;
const READY_TIMEOUT_MS = 30_000;
const STOP_TIMEOUT_MS = 5_000;

export interface SpawnedDsh {
  /** dsh 实际监听端口（OS 分配） */
  port: number;
  child: ChildProcess;
  /** 终止 dsh（SIGTERM，超时 SIGKILL），返回退出码 */
  stop(): Promise<number>;
}

/**
 * 在 PATH 中查找 dsh 可执行文件；`override` 直接使用。
 * 找不到返回 null。
 */
export function findDsh(override?: string): string | null {
  if (override) return override;
  const path = process.env.PATH ?? "";
  for (const dir of path.split(":")) {
    if (!dir) continue;
    for (const name of ["dsh", "dsh.cmd", "dsh.exe"]) {
      const candidate = `${dir}/${name}`;
      try {
        accessSync(candidate);
        return candidate;
      } catch {
        /* 继续找下一个 */
      }
    }
  }
  return null;
}

/**
 * spawn `dsh web --port 0 --no-open` 并等待其报告监听端口。
 * 就绪后把 dsh 的 stdout/stderr 透传到本进程。
 * dsh 启动失败/超时 → reject。
 */
export function spawnDsh(dshPath: string): Promise<SpawnedDsh> {
  return new Promise((resolve, reject) => {
    const child = spawn(dshPath, ["web", "--port", "0", "--no-open"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderrBuf = "";
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`dsh did not report a listening port within ${READY_TIMEOUT_MS}ms: ${stderrBuf.slice(0, 200)}`));
    }, READY_TIMEOUT_MS);

    const rl = createInterface({ input: child.stdout ?? undefined });
    rl.on("line", (line) => {
      const m = URL_LINE_RE.exec(line);
      if (m) {
        clearTimeout(timeout);
        // 就绪：后续 dsh 输出全部透传
        child.stdout?.pipe(process.stdout);
        child.stderr?.pipe(process.stderr);
        resolve({ port: Number(m[1]), child, stop: () => stopDsh(child) });
      } else {
        process.stdout.write(`${line}\n`);
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrBuf += chunk.toString("utf8");
    });
    child.on("error", (err) => {
      clearTimeout(timeout);
      reject(new Error(`failed to launch dsh: ${err.message}`));
    });
    child.on("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`dsh exited before reporting a port (code ${code ?? "?"})`));
    });
  });
}

function stopDsh(child: ChildProcess): Promise<number> {
  return new Promise((resolve) => {
    if (child.exitCode !== null) {
      resolve(child.exitCode);
      return;
    }
    child.once("exit", (code) => resolve(code ?? 0));
    child.kill("SIGTERM");
    setTimeout(() => child.kill("SIGKILL"), STOP_TIMEOUT_MS).unref();
  });
}
