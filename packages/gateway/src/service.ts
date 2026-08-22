/**
 * service.ts — 服务化：生成并安装 systemd unit（Linux）/ launchd plist（macOS）。
 *
 * 设计（roadmap M2）：不自带 fork 后台 —— 交给系统进程管理器托管 rdsh（连带其
 * spawn 的 dsh）；用户级安装（~/.config/systemd/user / ~/Library/LaunchAgents），
 * 无需 sudo；开机自启 + 崩溃重启（Restart=on-failure / KeepAlive）。
 */
import { mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

export const SERVICE_NAME = "rdsh";
const SYSTEMD_DIR = join(homedir(), ".config", "systemd", "user");
const SYSTEMD_UNIT = join(SYSTEMD_DIR, "rdsh.service");
const LAUNCHD_DIR = join(homedir(), "Library", "LaunchAgents");
const LAUNCHD_PLIST = join(LAUNCHD_DIR, "com.rdsh.plist");

function isLinux(): boolean {
  return process.platform === "linux";
}

function serviceLogPath(): string {
  return join(homedir(), ".rdsh", "service.log");
}

/** systemd 用户级 unit 模板。 */
export function systemdUnit(execStart: string, configPath: string): string {
  return `[Unit]
Description=rdsh — remote access for DeepSeek Harness
After=network.target

[Service]
Type=simple
ExecStart=${execStart} serve --config ${configPath}
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
`;
}

/** launchd plist 模板。 */
export function launchdPlist(execStart: string, configPath: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.rdsh</string>
  <key>ProgramArguments</key>
  <array>
    <string>${execStart}</string>
    <string>serve</string>
    <string>--config</string>
    <string>${configPath}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${serviceLogPath()}</string>
  <key>StandardErrorPath</key>
  <string>${serviceLogPath()}</string>
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
export async function installService(configPath: string): Promise<string> {
  const execStart = `${process.execPath} ${process.argv[1]}`;
  if (isLinux()) {
    await mkdir(SYSTEMD_DIR, { recursive: true });
    await writeFile(SYSTEMD_UNIT, systemdUnit(execStart, configPath), { mode: 0o600 });
    await run("systemctl", ["--user", "daemon-reload"]);
    await run("systemctl", ["--user", "enable", "--now", SERVICE_NAME]);
    return `installed systemd user unit: ${SYSTEMD_UNIT}`;
  }
  await mkdir(LAUNCHD_DIR, { recursive: true });
  await writeFile(LAUNCHD_PLIST, launchdPlist(execStart, configPath), { mode: 0o600 });
  await run("launchctl", ["load", LAUNCHD_PLIST]);
  return `installed launchd plist: ${LAUNCHD_PLIST}`;
}

/** 服务状态。 */
export async function serviceStatus(): Promise<string> {
  if (isLinux()) {
    try {
      const active = await run("systemctl", ["--user", "is-active", SERVICE_NAME]);
      return `active: ${active}`;
    } catch {
      return "inactive";
    }
  }
  try {
    await run("launchctl", ["print", "com.rdsh"]);
    return "active";
  } catch {
    return "unloaded";
  }
}

/** 停止并移除服务。 */
export async function uninstallService(): Promise<string> {
  if (isLinux()) {
    await run("systemctl", ["--user", "disable", "--now", SERVICE_NAME]).catch(() => undefined);
    await rm(SYSTEMD_UNIT, { force: true });
    await run("systemctl", ["--user", "daemon-reload"]).catch(() => undefined);
    return `removed ${SYSTEMD_UNIT}`;
  }
  await run("launchctl", ["unload", LAUNCHD_PLIST]).catch(() => undefined);
  await rm(LAUNCHD_PLIST, { force: true });
  return `removed ${LAUNCHD_PLIST}`;
}
