/**
 * rdsh — secure remote access for DeepSeek Harness.
 *
 * User-facing CLI: configure / join / serve this machine as a gateway or host.
 * The hub commands were split out to `rdsh-hub-cli` (bin `rdsh-hub`) in feature 47.
 */
import { readFileSync } from "node:fs";

export const NAME = "rdsh";

/** 版本单一来源：package.json（发布时 --version 与包版本一致，避免硬编码漏同步）。 */
export const VERSION = (
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }
).version;

export const DESCRIPTION =
  "Secure remote access for DeepSeek Harness: rdsh setup / join / serve (gateway & host)";
