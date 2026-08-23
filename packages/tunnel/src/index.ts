/**
 * rdsh-tunnel — wire protocol between rdsh-hub and rdsh-gateway.
 *
 * IMPORTANT (protocol-first): this package owns the cross-language contract
 * that the future Go implementation of rdsh-hub must also implement. The
 * canonical protocol description lives in PROTOCOL.md (FROZEN v1) — any
 * change to framing or message types must update it first, then add a
 * conformance test.
 */
export {
  encodeFrame,
  FrameParser,
  ProtocolError,
  jsonPayload,
  parseJsonPayload,
  FRAME_HEADER_LENGTH,
  MAX_PAYLOAD_LENGTH,
} from "./frame.ts";
export type { Frame, RequestOpen, ResponseOpen } from "./frame.ts";
export {
  MAGIC,
  PROTOCOL_VERSION,
  FRAME_TYPE,
  FLAG_E2E,
} from "./constants.ts";
