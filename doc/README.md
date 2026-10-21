# Public documentation

This directory is the **public** documentation surface of `remote-dsh`.

## What belongs here

| Path | Content |
|---|---|
| `blog/` | User-facing tutorials and scenario guides (zh / en) |
| `overview/` | Desensitized architecture, proposal, roadmap, feature list, usage |
| `../packages/*/README.md` | Per-package public READMEs |
| `../packages/tunnel/PROTOCOL.md` | The frozen `rdsh-tunnel` wire protocol |
| `../packages/hub/API.md` | The public hub API contract |
| `../e2e/` | Public protocol conformance fixtures |

## What does **not** belong here

Implementation-process and operations docs live in the **private repository**
(`whalelink`):

- `doc/feature/` — discussion / req / solution / plan / code-review / verification / summary / TODO
- `doc/fix/` — bug investigations and fix records
- `doc/review/` — internal reviews
- `doc/ops/` — production/staging runbooks (real hosts, IPs, paths)
- `doc/saas/` — legal/product source docs (the published static HTML lives in the website repo)

They were moved out of this repository on 2026-10-21 and archived at
`whalelink/doc/archive/remote-dsh/`. **Do not recreate these directories here.**
CI fails if `doc/feature`, `doc/fix`, `doc/review`, `doc/ops`, or `doc/saas` appears.

## Contributing docs

- User-facing changes → `doc/blog/` or `doc/overview/`.
- Protocol / API changes → `packages/tunnel/PROTOCOL.md` or `packages/hub/API.md`
  first, then implementation + conformance.
- Implementation plans, fix records, and internal reviews → private repository.
