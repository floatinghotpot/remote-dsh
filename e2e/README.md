# e2e/

**Public conformance for the canonical `rdsh-tunnel` protocol** (see
`packages/tunnel/PROTOCOL.md`).

The open-source side is the protocol spec plus language-agnostic fixtures and a
minimal TypeScript harness. The Go implementation (relay node, future hub) lives
in the private `rdsh-cloud` repository and runs the **same fixtures** in its CI.

This drives the "protocol-first" discipline: any framing change must pass both
implementations against the same conformance suite, and the public repo must
never depend on the private one.

## Contents

- `fixtures/frames.json` — language-agnostic frame vectors (encode/decode).
- `fixtures/README.md` — schema and consumer obligations.
- `../packages/tunnel/test/conformance.test.ts` — public TS harness.

The private Go implementation (`rdsh-cloud/internal/tunnel/conformance_test.go`)
runs the same `frames.json` with `RDSH_E2E_FIXTURES` set; the test skips when the
variable is unset so the private repo can build standalone.
