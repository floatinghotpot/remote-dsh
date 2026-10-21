/**
 * lock-diagnostics.ts — 插件侧「诊断」纯函数：持有者来源分类 + 本机插件安装扫描 + 卸载命令文本。
 *
 * 与文件系统解耦（`readDir` / `readPkgVersion` / `samePath` 均可注入），便于单测；
 * 生产默认用真实 `node:fs`。
 */
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** 一处命令行 profile 安装（`$DSH_HOME/profiles/<name>/node_modules/dsh-web-remote`）。 */
export interface InstallEntry {
  profile: string;
  path: string;
  version: string | null;
  /** 是否为本插件正在运行的这份（按真实路径比对）。 */
  self: boolean;
}

/** DSH 主目录（`DSH_HOME` 优先，否则 `~/.dsh`）。 */
export function dshHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.DSH_HOME ?? join(homedir(), ".dsh");
}

/**
 * 从持有者进程命令行判定来源：
 * - `desktop` —— 命令行含 `.app/` 或 `Electron`（DSH 桌面版）；
 * - `cli-profile:<name>` —— 含 `--profile <name>`（命令行 `dsh --profile …`）；
 * - `cli` —— 其余含 `dsh`；
 * - `unknown` —— 无命令行或无法识别。
 */
export function classifyHolder(command: string | undefined): string {
  if (typeof command !== "string" || command === "") return "unknown";
  if (/\.app\//i.test(command) || /Electron/i.test(command)) return "desktop";
  const m = /--profile\s+(\S+)/.exec(command);
  if (m) return `cli-profile:${m[1]}`;
  if (/remote-dsh/.test(command) || /\brdsh\b/.test(command) || /\bdsh\b/.test(command)) return "cli";
  return "unknown";
}

export interface ScanDeps {
  dshHome?: string;
  readDir?: (dir: string) => string[];
  readPkgVersion?: (pkgJsonPath: string) => string | null;
  samePath?: (a: string, b: string) => boolean;
}

/**
 * 扫 `$DSH_HOME/profiles/<name>/node_modules/dsh-web-remote/package.json`，列出命令行 profile 安装。
 * 桌面版那份不在 `$DSH_HOME/profiles` 下、扫不到 —— 桌面版来源靠持有者 `ps` 命令行识别（`classifyHolder`）。
 */
export function scanPluginInstalls(selfDir: string | undefined, deps: ScanDeps = {}): InstallEntry[] {
  const home = deps.dshHome ?? dshHome();
  const profilesDir = join(home, "profiles");
  const readDir = deps.readDir ?? ((dir: string) => readdirSync(dir));
  const readPkgVersion = deps.readPkgVersion ?? defaultReadPkgVersion;
  const samePath = deps.samePath ?? realpathEqual;
  let names: string[];
  try {
    names = readDir(profilesDir);
  } catch {
    return [];
  }
  const out: InstallEntry[] = [];
  for (const name of names) {
    if (name.startsWith(".")) continue;
    const dir = join(profilesDir, name, "node_modules", "dsh-web-remote");
    const version = readPkgVersion(join(dir, "package.json"));
    if (version !== null) {
      out.push({ profile: name, path: dir, version, self: selfDir !== undefined && samePath(dir, selfDir) });
    }
  }
  return out;
}

function defaultReadPkgVersion(pkgJsonPath: string): string | null {
  try {
    if (!existsSync(pkgJsonPath)) return null;
    const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf8")) as { version?: string };
    return typeof pkg.version === "string" ? pkg.version : null;
  } catch {
    return null;
  }
}

/** 真实路径比对（解析软链）；解析失败回退 `resolve` 字面比对。 */
function realpathEqual(a: string, b: string): boolean {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return resolve(a) === resolve(b);
  }
}

/** CLI profile 安装的卸载命令（桌面版那份靠用户在面板里卸载，这里不给命令）。 */
export function uninstallCommand(profile: string): string {
  return `dsh plugin --profile ${profile} remove dsh-web-remote`;
}
