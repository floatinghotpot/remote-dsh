# e2e/

Cross-language conformance tests: TS (rdsh-gateway) ↔ Go against the canonical
rdsh-tunnel protocol (see `packages/tunnel/PROTOCOL.md`).

The Go side is first delivered as the relay node (`go/cmd/rdsh-relay`, feature
30-relay-node) and later as the production hub (`go/cmd/rdsh-hub`).

Drives the "protocol-first" discipline: any framing change must pass both
implementations against the same conformance suite.
