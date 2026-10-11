# go/

Go server-side components for remote-dsh.

- **`cmd/rdsh-relay`** — standalone relay node (feature `30-relay-node`):
  tunnel ingress + data-plane forwarding, account service stays Node.
  `net/http` + WebSocket, `golang.org/x/crypto` (TLS + ACME autocert);
  single static binary, no CGO, no runtime dependency.
- **`internal/`** — shared `rdsh-tunnel` wire-protocol implementation,
  reused by `cmd/rdsh-relay` and the future `cmd/rdsh-hub`.
- **`cmd/rdsh-hub`** (future) — production-phase `rdsh-hub` rewrite (decision
  Q8): adds `modernc.org/sqlite` (pure Go, no CGO), `golang-jwt`, and
  `go:embed` of the rdsh-portal dist → single static binary.

All components implement the canonical `rdsh-tunnel` wire protocol
(`packages/tunnel/PROTOCOL.md`); conformance tests live in `../e2e/`.

Empty until the relay-node implementation lands.
