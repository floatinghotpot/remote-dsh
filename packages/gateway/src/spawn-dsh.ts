/**
 * spawn-dsh.ts — 发现并启动 dsh web，解析其实际监听端口。
 *
 * 事实依据（discussion.md §2）：`dsh web --port 0 --no-open` 由 OS 分配端口，
 * 启动时打印 `dsh web: http://127.0.0.1:<port>`（dsh-web-app/lib/index.js）。
 */
import { execFile, spawn } from "node:child_process";
import { accessSync } from "node:fs";
import { get } from "node:http";
import { createInterface } from "node:readline";
import type { ChildProcess } from "node:child_process";

/**
 * dsh 的 URL 行格式。0.1.1：`dsh web: http://127.0.0.1:<port>`；
 * 0.1.2+：`dsh web: http://127.0.0.1:<port>/?token=<launchToken> (LAN: ...)`。
 * 就绪行不锚定行尾（LAN 提示可随行出现）；token 为 base64url（[A-Za-z0-9_-]）。
 */
const URL_LINE_RE = /dsh web:\s*http:\/\/127\.0\.0\.1:(\d+)(?:\/\?token=([A-Za-z0-9_-]+))?/;
const READY_TIMEOUT_MS = 30_000;
const STOP_TIMEOUT_MS = 5_000;
const VERSION_TIMEOUT_MS = 5_000;
const EXCHANGE_TIMEOUT_MS = 5_000;

export interface SpawnedDsh {
  /** dsh 实际监听端口（OS 分配） */
  port: number;
  /**
   * 0.1.2+ 就绪行携带的 launch token（`/?token=` 后）；0.1.1 及更早为 undefined。
   * 有值才需要换发浏览器会话 cookie。
   */
  authToken?: string;
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
        resolve({ port: Number(m[1]), authToken: m[2], child, stop: () => stopDsh(child) });
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

/**
 * 用 launch token 向 dsh web 换发浏览器会话 cookie（0.1.2+ 认证）。
 * `GET /?token=<t>` → 303 + `Set-Cookie: dsh-auth-<sha256(authority)>=v1...`。
 * 用 node:http 而非 fetch：fetch 的 opaque-redirect 响应读不到 Set-Cookie。
 * 返回 cookie 的 `name=value` 段（不含属性）；换发失败/超时/无 cookie → null（调用方降级）。
 */
export function exchangeDshSessionCookie(port: number, token: string, timeoutMs = EXCHANGE_TIMEOUT_MS): Promise<string | null> {
  return new Promise((resolve) => {
    const req = get(
      { host: "127.0.0.1", port, path: `/?token=${encodeURIComponent(token)}` },
      (res) => {
        const raw = res.headers["set-cookie"];
        const list = Array.isArray(raw) ? raw : raw !== undefined ? [raw] : [];
        let found: string | null = null;
        for (const c of list) {
          const segment = c.split(";", 1)[0]?.trim() ?? "";
          if (segment.startsWith("dsh-auth-")) {
            found = segment;
            break;
          }
        }
        res.resume();
        resolve(found);
      },
    );
    req.on("error", () => resolve(null));
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      resolve(null);
    });
  });
}

/** 探测 dsh 版本号（`dsh --version` 输出如 `0.1.2-rc.1`）；失败/不可解析 → null。 */
export function detectDshVersion(dshPath: string, timeoutMs = VERSION_TIMEOUT_MS): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(dshPath, ["--version"], { timeout: timeoutMs }, (err, stdout) => {
      if (err) {
        resolve(null);
        return;
      }
      const first = stdout.trim().split(/\r?\n/)[0] ?? "";
      const m = first.match(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
      resolve(m !== null ? m[0] : null);
    });
  });
}

interface ParsedVersion {
  core: number[];
  pre: Array<number | string> | null;
}

function parseVersion(v: string): ParsedVersion | null {
  const m = v.trim().match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/);
  if (m === null) return null;
  const core = [Number(m[1]), Number(m[2]), Number(m[3])];
  const pre = m[4] !== undefined ? m[4].split(".").map((s) => (/^\d+$/.test(s) ? Number(s) : s)) : null;
  return { core, pre };
}

/**
 * 比较两个 dsh 版本串（如 `0.1.1-rc.2` / `0.1.2-rc.1`），支持 `-rc.N`/`-beta.N` 后缀：
 * 返回负/0/正；同 core 时 release 大于任何 prerelease；不可解析排序为「更旧」。
 * 语义对齐 dsh4vscode 的 compareVersions（跨仓库同一 dsh 版本约定）。
 */
export function compareDshVersions(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (pa === null && pb === null) return 0;
  if (pa === null) return -1;
  if (pb === null) return 1;
  for (let i = 0; i < 3; i++) {
    const x = pa.core[i]!;
    const y = pb.core[i]!;
    if (x !== y) return x - y;
  }
  if (pa.pre === null && pb.pre === null) return 0;
  if (pa.pre === null) return 1;
  if (pb.pre === null) return -1;
  const len = Math.max(pa.pre.length, pb.pre.length);
  for (let i = 0; i < len; i++) {
    const x = pa.pre[i];
    const y = pb.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (typeof x === "number" && typeof y === "number") {
      if (x !== y) return x - y;
    } else if (typeof x === "string" && typeof y === "string") {
      if (x !== y) return x < y ? -1 : 1;
    } else {
      return typeof x === "number" ? -1 : 1;
    }
  }
  return 0;
}

/**
 * remote-dsh 已实测兼容的 dsh 版本窗口（registry 实存版本定界）。
 * ⚠️ 适配新的 dsh 版本并真机实测后，须同步扩展此窗口（见 doc/fix/20260907-dsh-0.1.2-rc1-auth/）。
 */
export const DSH_COMPAT_MIN = "0.1.1-rc.2";
export const DSH_COMPAT_MAX = "0.1.2-rc.1";

/**
 * 版本落在实测窗口外时的提示文案（零文档导向：直接给动作指令，用户不查表）。
 * - 比 max 新 → 升级 remote-dsh 或暂用旧 dsh；
 * - 比 min 旧 → 升级 dsh；
 * - 在窗口内 / 探测失败（version=null）→ null（不提示）。
 */
export function dshVersionWarning(version: string | null): string | null {
  if (version === null) return null;
  if (compareDshVersions(version, DSH_COMPAT_MAX) > 0) {
    return (
      `检测到 dsh ${version}：该版本超出 remote-dsh 已实测范围（≤${DSH_COMPAT_MAX}），远程访问可能不可用。` +
      `升级 remote-dsh：npm i -g remote-dsh@latest；或暂用 dsh@${DSH_COMPAT_MIN}。`
    );
  }
  if (compareDshVersions(version, DSH_COMPAT_MIN) < 0) {
    return `检测到 dsh ${version}：版本过旧，请升级 dsh：npm i -g @deepseek-ai/dsh@latest。`;
  }
  return null;
}
