# Tunnel conformance fixtures

Language-agnostic test vectors for the canonical `rdsh-tunnel` v1 wire protocol
(see [`../../packages/tunnel/PROTOCOL.md`](../../packages/tunnel/PROTOCOL.md)).

**One source of truth:** the public TypeScript implementation and the private Go
implementation (`rdsh-cloud`) both consume `frames.json`. Do not add
implementation-specific fixtures here.

## Schema

```json
{
  "protocolVersion": 1,
  "headerLength": 15,
  "cases": [
    {
      "name": "data-hello",
      "encodedHex": "52445348...",
      "version": 1,
      "flags": 0,
      "type": 2,
      "streamId": 7,
      "payloadHex": "68656c6c6f"
    }
  ],
  "sticky": {
    "name": "sticky-three",
    "encodedHex": "52445348...",
    "frames": [ /* same shape as cases */ ]
  }
}
```

- **`encodedHex`** — the exact bytes on the wire (hex).
- **`version` / `flags` / `type` / `streamId` / `payloadHex`** — the expected
  decoded frame.
- **`sticky`** — one buffer containing several frames back-to-back; the parser
  must return all frames in order (sticky packets).

## Consumer obligations

1. **Decode** `encodedHex` with the streaming parser; assert exactly one frame
   (or, for `sticky`, all frames in order) with the expected fields.
2. **Re-encode** the expected fields; assert the result is byte-identical to
   `encodedHex`.
3. A fixture change is a **protocol change**: update `PROTOCOL.md` first, then
   both implementations, then this file.

## Consumers

| Implementation | Location | How |
|---|---|---|
| TypeScript | `packages/tunnel/test/conformance.test.ts` | `pnpm --filter rdsh-tunnel test` |
| Go | private `rdsh-cloud/internal/tunnel/conformance_test.go` | `RDSH_E2E_FIXTURES=/abs/path/to/e2e/fixtures/frames.json go test ./...` |

> **Path note:** Go resolves relative paths from the package directory
> (`internal/tunnel`), so pass an **absolute path** (or `../../../remote-dsh/e2e/fixtures/frames.json`
> from that directory). CI should use an absolute path.

The Go test **skips** when `RDSH_E2E_FIXTURES` is unset, so the private repo can
run without a public checkout; CI checks out both repos and sets the variable.
