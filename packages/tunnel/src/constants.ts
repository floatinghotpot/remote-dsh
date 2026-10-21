/**
 * constants.ts — 协议常量（PROTOCOL.md，FROZEN v1）。
 */
/** magic "RDSH"。 */
export const MAGIC = Buffer.from([0x52, 0x44, 0x53, 0x48]);

export const PROTOCOL_VERSION = 1;

/** 帧类型。 */
export const FRAME_TYPE = {
  OPEN: 0x01,
  DATA: 0x02,
  CLOSE: 0x03,
  PING: 0x04,
  PONG: 0x05,
  ERROR: 0x06,
  /** 扩展帧（≥ 0x80）：P1.5 存量迁移（节点→gateway 下发改连节点）。A2 预留。 */
  REDIRECT: 0x80,
} as const;

/** 核心帧/扩展帧分界（A1）：`type < 0x80` 核心（未知 = 协议错误），`≥ 0x80` 扩展（未知 = 忽略）。 */
export const CORE_TYPE_MAX = 0x7f;

/** E2E 加密预留位（flags bit0）：实现必须忽略未知位并原样透传。 */
export const FLAG_E2E = 0x01;
