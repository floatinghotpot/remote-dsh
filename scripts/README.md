# scripts

Developer/ops tooling for the remote-dsh monorepo.

## sync-and-build.sh

One-command update of a source checkout: pull the latest code from GitHub and
rebuild it into a working global `rdsh`.

```bash
./scripts/sync-and-build.sh
```

**Use it on** machines that run `rdsh` from a source checkout (e.g. the
production ECS): after a developer pushes to GitHub, this brings the checkout
up to date and rebuilds in one step.

### What it does

1. `git pull --ff-only` — fast-forward only; fails instead of merging, so a
   diverged local branch is surfaced rather than silently resolved.
2. `pnpm install --frozen-lockfile` — deps locked to `pnpm-lock.yaml`.
3. Build **portal first**, then the remaining packages:
   `pnpm --filter rdsh-portal build` then `pnpm -r --filter '!rdsh-portal' build`.
   - Order matters: the hub build (`scripts/copy-portal.mjs`) **replaces**
     `packages/hub/portal` with the freshly built `packages/portal/dist`.
     Building hub before portal would wipe the committed portal assets.
4. `npm link` in `packages/cli` — the global `rdsh` now points at this
   checkout's `dist`.

### Effects and caveats

- **`npm link` overrides any globally installed `remote-dsh`** — after running
  this, `rdsh` resolves to this checkout. Run it on machines where that is the
  intent (the ECS); on a developer laptop it would shadow the npm-installed
  package.
- **Running hub/join services are NOT restarted.** Rebuild only replaces the
  code on disk; restart the services (`rdsh hub service restart`, or kill and
  re-run) to pick it up.
- No destructive git operations (`--ff-only`, no force), no service restarts,
  no network-exposed side effects.

### Prerequisites

- `pnpm` (`npm i -g pnpm`), Node ≥ 22
- SSH access to `github.com` (the remote is `git@github.com:...`)
- Permission to `npm link` globally (user-level npm install works)

### Verify after running

```bash
rdsh --version        # reflects the checkout's version
pnpm test             # full suite (tunnel/hub/gateway)
```
