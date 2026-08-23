// 构建后把 portal 构建产物复制到 hub 包内（发布时随包分发 —— npm 安装的
// hub 必须自带 portal 静态资源，不能依赖 workspace 相对路径）。
import { cp, rm, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const hubRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(hubRoot, "..", "portal", "dist");
const dest = join(hubRoot, "portal");

await rm(dest, { recursive: true, force: true });
await mkdir(dest, { recursive: true });
await cp(src, dest, { recursive: true });
console.log("portal copied to packages/hub/portal");
