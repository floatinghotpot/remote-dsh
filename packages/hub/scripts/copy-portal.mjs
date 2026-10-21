// 构建后把 portal 构建产物复制到 hub 包内（发布时随包分发 —— npm 安装的
// hub 必须自带 portal 静态资源，不能依赖 workspace 相对路径）。
//
// 为什么先校验再删：hub 与 portal 在 `pnpm -r build` 里是并行调度的（hub 不依赖 rdsh-portal），
// 旧实现先 `rm -rf packages/hub/portal` 再 `cp`，一旦 portal/dist 还不存在（干净 clone 上尤其常见，
// dist 不入库）就 **ENOENT 失败，并留下被删掉的入库产物**；不失败时也可能复制到上一轮的旧产物。
//
// 校验语义（mtime 是 DX 兜底，非安全边界；vite build 默认清空 dist，所以 index.html 新鲜 ≈ 全套产物新鲜）：
//   ① 输入 = portal 源码白名单；跳过 dotfiles / node_modules。
//   ② dist/index.html 必须存在、且不旧于最新输入。
//   ③ index.html 引用的 assets/*.js|css 必须都在（防"index.html 在但资源缺失"的半成品）。
// 见私有仓 fix 记录（构建顺序）。
import { cp, mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const hubRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const portalRoot = join(hubRoot, "..", "portal");
const src = join(portalRoot, "dist");
const dest = join(hubRoot, "portal");

/** 文件 mtime；不存在 → null。 */
async function mtimeOrNull(p) {
  try {
    return (await stat(p)).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * 递归求目录下最新 mtime。跳过：dotfiles（.DS_Store 等）、node_modules。
 */
async function newestMtime(dir) {
  let newest = 0;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const p = join(dir, entry.name);
    const m = entry.isDirectory() ? await newestMtime(p) : await mtimeOrNull(p);
    if (m !== null && m > newest) newest = m;
  }
  return newest;
}

// ① 输入最新 mtime（白名单）
const inputDirs = ["src", "scripts", "public"];
const inputFiles = ["index.html", "vite.config.ts", "tsconfig.json", "package.json"];
let inputNewest = 0;
for (const rel of inputDirs) {
  const m = await newestMtime(join(portalRoot, rel)).catch(() => 0);
  if (m > inputNewest) inputNewest = m;
}
for (const rel of inputFiles) {
  const m = await mtimeOrNull(join(portalRoot, rel));
  if (m !== null && m > inputNewest) inputNewest = m;
}
// ② dist/index.html 必须存在且不旧于最新输入
const distHtml = join(src, "index.html");
const distMtime = await mtimeOrNull(distHtml);
if (distMtime === null) {
  console.error(`copy-portal: ${distHtml} 不存在 —— 先构建 portal（pnpm --filter ./packages/portal build）`);
  process.exit(1);
}
if (distMtime < inputNewest) {
  console.error(
    `copy-portal: portal/dist 比源码旧（dist=${new Date(distMtime).toISOString()} < src=${new Date(inputNewest).toISOString()}）` +
      " —— 重新构建 portal 后再复制",
  );
  process.exit(1);
}

// ③ index.html 引用的 assets 必须都在（防半成品）
const html = await readFile(distHtml, "utf8");
const refs = [...html.matchAll(/(?:src|href)="[^"]*\/(assets\/[^"]+)"/g)].map((m) => m[1]);
for (const ref of refs) {
  if ((await mtimeOrNull(join(src, ref))) === null) {
    console.error(`copy-portal: ${src}/${ref} 缺失（index.html 引用了它）—— 产物不完整，重新构建 portal`);
    process.exit(1);
  }
}

await rm(dest, { recursive: true, force: true });
await mkdir(dest, { recursive: true });
await cp(src, dest, { recursive: true });
console.log("portal copied to packages/hub/portal");
