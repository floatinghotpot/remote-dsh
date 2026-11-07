/**
 * host-meta.ts — 主机元数据快照（`rdsh-meta.json`）。
 *
 * 职责边界：**外层写、内层读**。
 * - 写入方：`rdsh join`（seed）、DSH 插件启动、盒子安装/升级流程；
 * - 读取方：gateway 的 `UsageReporter`，只用于 `POST /api/hosts/self/meta`。
 *
 * 与 `host.json` 分开：`host.json` 是配置（mode / hub / token），本文件回答"我是谁、我是什么版本"，
 * 由不同组件在不同时机写；gateway 不反查 /etc、不 spawn dsh 取版本。
 *
 * 路径：与 `host.json` 同目录（`--config` 跟随）。
 * 写入：临时文件 + `rename` 原子替换，`0644`（只含形态与版本号，无秘密）。
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_HOST_CONFIG_PATH, isDeviceKind } from "./config.ts";
import type { DeviceKind } from "./config.ts";

export const HOST_META_SCHEMA = 1;
export const HOST_META_FILE = "rdsh-meta.json";

/** 版本键用 npm 包全名：`remote-dsh` / `rdsh-gateway` / `dsh-web-remote` / `@deepseek-ai/dsh` / `rdsh-boxd`。 */
export interface HostMeta {
  schema: number;
  deviceKind?: DeviceKind;
  updatedAt?: string;
  versions: Record<string, string>;
}

/** 默认位置：与 `~/.rdsh/host.json` 同目录。 */
export function defaultHostMetaPath(): string {
  return join(dirname(DEFAULT_HOST_CONFIG_PATH), HOST_META_FILE);
}

/** 与给定 `host.json` 同目录的元数据文件。 */
export function hostMetaPathFor(configPath: string): string {
  return join(dirname(configPath), HOST_META_FILE);
}

/**
 * 读取元数据；文件缺失/损坏 → `null`（调用方据此少报该字段，而不是编造默认值）。
 */
export function readHostMeta(path: string = defaultHostMetaPath()): HostMeta | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const raw = parsed as { schema?: unknown; deviceKind?: unknown; updatedAt?: unknown; versions?: unknown };
  const versions: Record<string, string> = {};
  if (typeof raw.versions === "object" && raw.versions !== null && !Array.isArray(raw.versions)) {
    for (const [key, value] of Object.entries(raw.versions as Record<string, unknown>)) {
      if (typeof value === "string" && value !== "") versions[key] = value;
    }
  }
  const meta: HostMeta = {
    schema: typeof raw.schema === "number" ? raw.schema : HOST_META_SCHEMA,
    versions,
  };
  if (isDeviceKind(raw.deviceKind)) meta.deviceKind = raw.deviceKind;
  if (typeof raw.updatedAt === "string") meta.updatedAt = raw.updatedAt;
  return meta;
}

/**
 * 合并写入：`versions` 按键合并（不清掉别的组件写的键），`deviceKind` 缺省保留原值。
 *
 * 盒子安装/升级流程可以只写 `{versions: {"rdsh-boxd": "0.2.0"}}`，不会抹掉 CLI 写的版本。
 */
export function writeHostMeta(
  patch: { deviceKind?: DeviceKind; versions?: Record<string, string> },
  path: string = defaultHostMetaPath(),
): HostMeta {
  const previous = readHostMeta(path);
  const meta: HostMeta = {
    schema: HOST_META_SCHEMA,
    versions: { ...(previous?.versions ?? {}), ...(patch.versions ?? {}) },
    updatedAt: new Date().toISOString(),
  };
  const deviceKind = patch.deviceKind ?? previous?.deviceKind;
  if (deviceKind !== undefined) meta.deviceKind = deviceKind;
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(meta, null, 2)}\n`, { mode: 0o644 });
  renameSync(tmp, path);
  return meta;
}

/** 读包自身 `package.json` 的版本；`fromUrl` 传 `import.meta.url`。失败 → null。 */
export function readPackageVersion(fromUrl: string): string | null {
  try {
    const pkgPath = join(dirname(fileURLToPath(fromUrl)), "..", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: unknown };
    return typeof pkg.version === "string" && pkg.version !== "" ? pkg.version : null;
  } catch {
    return null;
  }
}

/** 本包（`rdsh-gateway`）的版本。 */
export function gatewayVersion(): string | null {
  return readPackageVersion(import.meta.url);
}