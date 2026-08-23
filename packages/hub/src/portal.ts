/**
 * portal.ts — 静态服务 portal 构建产物（Vite dist）。
 *
 * 部署形态：`rdsh hub serve` 从包内服务 portal；目录定位相对本文件
 * （monorepo：packages/hub → packages/portal/dist）。
 */
import { createReadStream, existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** monorepo 内 portal dist 的解析路径（dev 与构建后 dist/ 一致：相对本文件 ../../portal/dist）。 */
export function defaultPortalDir(): string {
  // hub 包内 portal/（构建时从 packages/portal/dist 复制；随 npm 包分发）
  return resolve(fileURLToPath(new URL("../portal", import.meta.url)));
}

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".map": "application/json",
};

/** 服务 portal 静态文件；返回是否已处理（false = 交给 404 兜底）。
 * portal 部署在 /portal 前缀下（host 转发的 DSH 占用根路径）；历史裸路径
 * （/login /hosts 等）兼容重定向到 /portal。 */
export async function servePortal(req: IncomingMessage, res: ServerResponse, portalDir: string): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://rdsh.local");
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === "/" || pathname === "/index.html") {
    // 根路径归 host 转发；无 host 时 portal 兜底（历史路径 /login 等）
    res.writeHead(302, { location: "/portal" });
    res.end();
    return true;
  }
  if (pathname.startsWith("/portal")) {
    pathname = pathname.slice("/portal".length) || "/";
  } else if (pathname === "/login" || pathname === "/hosts" || pathname.startsWith("/host/") || pathname.startsWith("/settings/")) {
    res.writeHead(302, { location: `/portal${pathname}` });
    res.end();
    return true;
  }
  if (pathname === "/") pathname = "/index.html";

  // 防目录穿越：解析后必须仍在 portalDir 内
  const root = resolve(portalDir);
  const target = resolve(join(root, normalize(pathname).replace(/^[/\\]+/, "")));
  if (!target.startsWith(root + "/") && target !== root) {
    res.writeHead(403, { "content-type": "text/plain" });
    res.end("forbidden");
    return true;
  }

  if (!existsSync(target)) {
    // SPA fallback：非静态资源路径 → index.html（portal 前端路由）
    const index = join(root, "index.html");
    if (!existsSync(index)) return false;
    res.writeHead(200, { "content-type": CONTENT_TYPES[".html"] ?? "text/html", "cache-control": "no-store" });
    res.end(await readFile(index));
    return true;
  }

  const type = CONTENT_TYPES[extname(target)] ?? "application/octet-stream";
  const isAsset = /\.(js|css|woff2|png|svg|ico|map)$/.test(target);
  res.writeHead(200, {
    "content-type": type,
    "cache-control": isAsset ? "public, max-age=31536000, immutable" : "no-store",
  });
  createReadStream(target).pipe(res);
  return true;
}
