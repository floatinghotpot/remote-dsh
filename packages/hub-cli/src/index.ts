/**
 * rdsh-hub-cli — server-side CLI for the rdsh hub.
 *
 * Split from `remote-dsh` (feature 47): the user-facing `rdsh` keeps only the
 * gateway/host commands, while `rdsh-hub` runs and manages the hub server.
 */
import { readFileSync } from "node:fs";

export const NAME = "rdsh-hub";

/** 版本单一来源：package.json（发布时 --version 与包版本一致）。 */
export const VERSION = (
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }
).version;

export const DESCRIPTION = "Run and manage the rdsh hub server";
