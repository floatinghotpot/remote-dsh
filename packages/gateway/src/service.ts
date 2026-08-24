/**
 * service.ts — 服务化：生成并安装 systemd unit（Linux）/ launchd plist（macOS）。
 *
 * 设计（roadmap M2）：不自带 fork 后台 —— 交给系统进程管理器托管 rdsh（连带其
 * spawn 的 dsh）；用户级安装（~/.config/systemd/user / ~/Library/LaunchAgents），
 * 无需 sudo；开机自启 + 崩溃重启（Restart=on-failure / KeepAlive）。
 *
 * 服务名：serve/hub 共用 "rdsh"；join 用 "rdsh-join"（同机可与 hub 并存，互不覆盖）。
 */
import { mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

/** serve/hub 共用的服务名。 */
export const SERVICE_NAME = "rdsh";
/** join 的独立服务名（同机可与 hub 的 rdsh.service 并存）。 */
export const JOIN_SERVICE_NAME = "rdsh-join";

const SYSTEMD_DIR = join(homedir(), ".config", "systemd", "user");
const LAUNCHD_DIR = join(homedir(), "Library", "LaunchAgents");

function systemdUnitPath(name: string): string {
  return join(SYSTEMD_DIR, `${name}.service`);
}

function launchdPlistPath(name: string): string {
  return join(LAUNCHD_DIR, `com.${name}.plist`);
}

function isLinux(): boolean {
  return process.platform === "linux";
}

/** 日志文件：rdsh → service.log（历史兼容）；其余按服务名（如 rdsh-join.log）。 */
function serviceLogPath(name: string): string {
  return join(homedir(), ".rdsh", name === SERVICE_NAME ? "service.log" : `${name}.log`);
}

/** 服务化规格。 */
export interface ServiceSpec {
  /** 服务名（systemd unit 文件名 / launchd Label）。 */
  name: string;
  /** 命令参数（不含 --config）。如 ["serve"] / ["hub","serve"] / ["join",hubUrl,"--dsh",abs]。 */
  args: string[];
  /** 配置文件路径；提供则追加 `--config <path>`（serve/hub）。 */
  configPath?: string;
  /** 环境文件路径；提供则在 systemd unit 追加 `EnvironmentFile=-<path>`（launchd 暂不支持，忽略）。 */
  envFile?: string;
}

/** 命令参数（是否追加 --config）。 */
function commandArgs(spec: ServiceSpec): string[] {
  return spec.configPath !== undefined ? [...spec.args, "--config", spec.configPath] : spec.args;
}

/** systemd 用户级 unit 模板。 */
export function systemdUnit(execStart: string, spec: ServiceSpec): string {
  const envLine = spec.envFile !== undefined ? `EnvironmentFile=-${spec.envFile}\n` : "";
  return `[Unit]
Description=rdsh — remote access for DeepSeek Harness
After=network.target

[Service]
Type=simple
${envLine}ExecStart=${execStart} ${commandArgs(spec).join(" ")}
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
`;
}

/** launchd plist 模板。 */
export function launchdPlist(execStart: string, spec: ServiceSpec): string {
  const args = commandArgs(spec).map((a) => `    <string>${a}</string>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.${spec.name}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${execStart}</string>
${args}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${serviceLogPath(spec.name)}</string>
  <key>StandardErrorPath</key>
  <string>${serviceLogPath(spec.name)}</string>
</dict>
</plist>
`;
}

async function run(cmd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileP(cmd, args);
    return String(stdout).trim();
  } catch (err) {
    throw new Error(`${cmd} ${args.join(" ")} failed: ${(err as Error).message}`);
  }
}

/** 安装并启动服务（用户级）。 */
export async function installService(spec: ServiceSpec): Promise<string> {
  const execStart = `${process.execPath} ${process.argv[1]}`;
  if (isLinux()) {
    await mkdir(SYSTEMD_DIR, { recursive: true });
    await writeFile(systemdUnitPath(spec.name), systemdUnit(execStart, spec), { mode: 0o600 });
    await run("systemctl", ["--user", "daemon-reload"]);
    await run("systemctl", ["--user", "enable", "--now", spec.name]);
    return `installed systemd user unit: ${systemdUnitPath(spec.name)}`;
  }
  await mkdir(LAUNCHD_DIR, { recursive: true });
  await writeFile(launchdPlistPath(spec.name), launchdPlist(execStart, spec), { mode: 0o600 });
  await run("launchctl", ["load", launchdPlistPath(spec.name)]);
  return `installed launchd plist: ${launchdPlistPath(spec.name)}`;
}

/** 服务状态。 */
export async function serviceStatus(name: string = SERVICE_NAME): Promise<string> {
  if (isLinux()) {
    try {
      const active = await run("systemctl", ["--user", "is-active", name]);
      return `active: ${active}`;
    } catch {
      return "inactive";
    }
  }
  try {
    await run("launchctl", ["print", `com.${name}`]);
    return "active";
  } catch {
    return "unloaded";
  }
}

/** 停止并移除服务。 */
export async function uninstallService(name: string = SERVICE_NAME): Promise<string> {
  if (isLinux()) {
    await run("systemctl", ["--user", "disable", "--now", name]).catch(() => undefined);
    await rm(systemdUnitPath(name), { force: true });
    await run("systemctl", ["--user", "daemon-reload"]).catch(() => undefined);
    return `removed ${systemdUnitPath(name)}`;
  }
  await run("launchctl", ["unload", launchdPlistPath(name)]).catch(() => undefined);
  await rm(launchdPlistPath(name), { force: true });
  return `removed ${launchdPlistPath(name)}`;
}
