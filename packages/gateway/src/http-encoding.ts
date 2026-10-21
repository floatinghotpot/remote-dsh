/**
 * http-encoding.ts — 响应体 `content-encoding` 的解码/重编码（供 loopback JS 补丁使用）。
 *
 * 背景（2026-09-14 实测事故）：dsh 在客户端声明 `accept-encoding` 时会对 JS **gzip 压缩**，
 * 而 `patchLoopbackJs()` 是在字节里做字面量替换 —— 在压缩体上必然 miss（fail-open 静默失效），
 * 导致前端 `isLoopback` 判定没被改写、DSH 设置页/API key 界面不可用。
 *
 * 约定：只处理 identity/gzip/deflate/br；**未知或多重编码返回 null**，调用方 fail-open（原样透传）。
 */
import { brotliCompressSync, brotliDecompressSync, deflateSync, gunzipSync, gzipSync, inflateSync } from "node:zlib";

/** 取首个 content-encoding（小写；identity/空 → ""）。 */
export function firstEncoding(value: string | string[] | undefined): string {
  const raw = Array.isArray(value) ? value[0] : value;
  const enc = (raw ?? "").split(",")[0]?.trim().toLowerCase() ?? "";
  return enc === "identity" ? "" : enc;
}

/** 解码为明文；不支持/损坏 → null。 */
export function decodeBody(body: Buffer, encoding: string): Buffer | null {
  try {
    if (encoding === "") return body;
    if (encoding === "gzip") return gunzipSync(body);
    if (encoding === "deflate") return inflateSync(body);
    if (encoding === "br") return brotliDecompressSync(body);
    return null;
  } catch {
    return null;
  }
}

/** 按原编码重新压缩；identity → 原样；不支持/失败 → null。 */
export function encodeBody(body: Buffer, encoding: string): Buffer | null {
  try {
    if (encoding === "") return body;
    if (encoding === "gzip") return gzipSync(body);
    if (encoding === "deflate") return deflateSync(body);
    if (encoding === "br") return brotliCompressSync(body);
    return null;
  } catch {
    return null;
  }
}
