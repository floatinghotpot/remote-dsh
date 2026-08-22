/**
 * rdsh-tunnel — wire protocol between rdsh-hub and rdsh-gateway.
 *
 * IMPORTANT (protocol-first): this package owns the cross-language contract
 * that the future Go implementation of rdsh-hub must also implement. The
 * canonical protocol description lives in PROTOCOL.md — any change to framing
 * or message types must update it first, then add a conformance test.
 */
export const PROTOCOL_VERSION = 1;
