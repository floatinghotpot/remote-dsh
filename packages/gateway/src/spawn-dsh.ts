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
 * 注入给 dsh 的「远端操作者」信号值。用可读字面量而非 `/dev/...`：
 * 让 `env` 里一眼看出这是 rdsh 注入的，而不是真实终端路径。
 */
export const RDSH_REMOTE_TTY = "rdsh-remote";

/**
 * 构造 spawn dsh 时的环境：保证 dsh 把目录选择器解析为 **browse**（浏览器内目录浏览器）。
 *
 * 事实依据（doc/fix/20260917-remote-workspace-picker/discussion.md F2/F4/F8）：
 * `@deepseek-ai/dsh-host-directory-picker-auto` 在 boot 时读 `SSH_CONNECTION`/`SSH_TTY`
 * （仅继承进程层，非空即可）——「操作者看不到宿主显示」正是 rdsh 的场景（等价于
 * SSH 端口转发下的无人值守宿主）。不注入它，宿主是 macOS/Windows/带 DISPLAY 的 Linux
 * 时会解析成 `native`，原生对话框弹在宿主屏幕上、远端浏览器无法操作。
 *
 * 只设 `SSH_TTY`：`SSH_CONNECTION` 有固定 `"ip port ip port"` 格式，写假值会误导解析它的工具。
 * 用户真的在 SSH 会话里启动时（已有非空信号）保持原值不动。
 *
 * ⚠️ 这是上游启发式的输入：上游若改变判定信号，本注入会静默失效（spawn 后自检见
 * `checkRemotePickerGraph` 与 doc/fix/20260917-remote-workspace-picker/solution.md §6）。
 */
export function dshSpawnEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const hasSignal = (base.SSH_TTY ?? "") !== "" || (base.SSH_CONNECTION ?? "") !== "";
  if (hasSignal) return { ...base };
  return { ...base, SSH_TTY: RDSH_REMOTE_TTY };
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
      env: dshSpawnEnv(),
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

const GRAPH_CHECK_TIMEOUT_MS = 5_000;
const MAX_GRAPH_BYTES = 512 * 1024;

/** boot graph 里浏览器内目录选择器的客户端模块标识（命中即说明 picker = browse）。 */
const BROWSE_PICKER_MODULE = "@deepseek-ai/dsh-client-ui-directory-picker-browse";

/**
 * 自检：spawn 出的 dsh 是否真的把目录选择器解析成了 **browse**。
 *
 * 方法（与 doc/fix/20260917-remote-workspace-picker 的验证手段一致）：取一次首页，
 * 在注入的 boot graph 里找浏览器内选择器的客户端模块 —— 在 → 远端浏览器可用；
 * 不在 → 选择器是 `native`（原生对话框弹在宿主屏幕上）。
 *
 * @returns `true`（已挂载 browse）/ `false`（确认未挂载）/ `null`（无法判定：网络、鉴权、超限）
 * 只有 `false` 才值得告警；`null` 静默，避免噪声。
 */
export function checkRemotePickerGraph(
  port: number,
  cookieHeader: string | null = null,
  timeoutMs = GRAPH_CHECK_TIMEOUT_MS,
): Promise<boolean | null> {
  return new Promise((resolve) => {
    const headers: Record<string, string> = { Host: `127.0.0.1:${port}` };
    if (cookieHeader !== null) headers.Cookie = cookieHeader;
    let settled = false;
    const finish = (value: boolean | null): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const req = get({ host: "127.0.0.1", port, path: "/", headers }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        finish(null);
        return;
      }
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        body += chunk;
        if (body.length > MAX_GRAPH_BYTES) {
          req.destroy();
          finish(null);
        }
      });
      res.on("end", () => finish(body.includes(BROWSE_PICKER_MODULE)));
      res.on("error", () => finish(null));
    });
    req.on("error", () => finish(null));
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      finish(null);
    });
  });
}

/**
 * 自检失败（确认未挂载浏览器内选择器）时的告警文案。
 * 零文档导向：说清后果 + 直接给动作。
 */
export function remotePickerWarning(): string {
  return (
    "rdsh: 远端浏览器的目录选择器不是浏览器内目录浏览器（很可能是宿主原生对话框，远端无法操作）。" +
    "若装了 dsh-web-remote 插件，请检查 profile 的 cordis.patch.yml 是否被其它 patch 层覆盖（目录选择器只允许一个 pin 通道）。" +
    "否则可能是 dsh 版本变更导致远端信号失效——升级 remote-dsh：npm i -g remote-dsh@latest。"
  );
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
 * 2026-09-11：MAX 扩到 `0.1.5-rc.2` —— 真机实测通过（spawn + ready 行 token + 会话 cookie 换发 +
 * `/api` 转发 + HTML 注入 + WS `/api/remote.mux` 桥接 + join 的 `patchLoopbackJs` 命中），
 * 见 doc/review/20260911-dsh-0.1.5-rc.2-plugin-compat.md §5。
 * 2026-09-24：MAX 扩到 `0.1.7-rc.1` —— 同一份 G1–G7 清单重跑通过。0.1.7 只改前端 dist 形态
 * （`<base href="./">` + 相对 `plugins/…`），认证/RPC 未变；网关是同源透明代理，相对引用由浏览器
 * 解析成绝对路径后原样转发，故不受影响，见 doc/review/20260924-dsh-0.1.7-rc.1-compat.md。
 */
export const DSH_COMPAT_MIN = "0.1.1-rc.2";
export const DSH_COMPAT_MAX = "0.1.7-rc.1";

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
