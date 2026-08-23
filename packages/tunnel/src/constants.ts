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
} as const;

/** E2E 加密预留位（flags bit0）：实现必须忽略未知位并原样透传。 */
export const FLAG_E2E = 0x01;
