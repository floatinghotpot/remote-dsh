# go/

Production-phase `rdsh-hub` implementation (Go), per decision Q8:

- Standard Go ecosystem: `net/http` + `gorilla/websocket`,
  `modernc.org/sqlite` (pure Go, no CGO), `golang-jwt`, `golang.org/x/crypto`
- `go:embed` bundles the rdsh-portal dist → single static binary
- Implements the canonical `rdsh-tunnel` wire protocol (see
  `packages/tunnel/PROTOCOL.md`); conformance tests live in `../e2e/`

Empty until the prototype (TS hub) is validated.
