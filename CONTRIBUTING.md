# Contributing to remote-dsh

Thanks for your interest! This project is in its early stage. Here is how to
get oriented.

## Ground rules

- **Code, identifiers and commit messages in English**; user-facing docs in
  `doc/` are in Chinese (repository convention).
- **Minimal dependencies**: prefer Node built-ins (`node:http`, `node:sqlite`,
  `node:crypto`, `node:test`) over new packages; justify any new dependency.
- **Protocol-first**: `rdsh-tunnel` (layer 2) and the hub public API (layer 1)
  are cross-language contracts — changes must update the protocol docs in
  `packages/tunnel/` first.
- **Surgical changes**: touch only what the task requires. No drive-by
  refactors, no global reformatting.
- **Zero-defect gate**: TypeScript changes must pass `tsc --strict`
  (`pnpm build`); plain JS must pass `node --check`.

## Development setup

```bash
git clone git@github.com:<you>/remote-dsh.git
cd remote-dsh
corepack enable          # or install pnpm separately
pnpm install
pnpm build               # tsc across packages/*
pnpm test                # node --test
```

## Feature pipeline

Features follow `discussion → req → solution → plan → verification` under
`doc/feature/NN-name/` (see `CLAUDE.md` §6). Requirements (`req.md`) must be
approved before implementation starts.

## Commit conventions

- Conventional Commits style: `feat(scope): summary` / `fix(scope): summary`.
- Batch commits use explicit file lists; no `git add .`.
- Push to a public repository requires explicit confirmation.

## Open questions

See `doc/overview/proposal.md` §10 — open decisions are tracked there before
they land in `req.md` files.
