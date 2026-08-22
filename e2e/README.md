# e2e/

Cross-language conformance tests: TS (rdsh-gateway) ↔ Go (rdsh-hub) against
the canonical rdsh-tunnel protocol (see `packages/tunnel/PROTOCOL.md`).

Drives the "protocol-first" discipline: any framing change must pass both
implementations against the same conformance suite.

Active once the Go hub lands (M6).
