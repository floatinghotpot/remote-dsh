/**
 * rdsh — secure remote access for DeepSeek Harness.
 *
 * This package is the unified CLI (`rdsh serve` / `rdsh join` / `rdsh hub`).
 * v0.1.0 was a name-reservation skeleton; commands land with M1/M2/M3.
 */
import { readFileSync } from "node:fs";

export const NAME = "rdsh";

/** 版本单一来源：package.json（发布时 --version 与包版本一致，避免硬编码漏同步）。 */
export const VERSION = (
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }
).version;

export const DESCRIPTION =
  "Secure remote access for DeepSeek Harness: rdsh serve / rdsh join / rdsh hub";
