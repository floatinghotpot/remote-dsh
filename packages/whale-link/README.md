# dsh-whale-link

**Name reservation package.** This package currently exists only to reserve the
`dsh-whale-link` name on npm.

## Status

| | |
|---|---|
| Implementation | ❌ not here — the working plugin is [`dsh-web-remote`](../web-remote) |
| Installable | ❌ not yet — `index.js` deliberately throws |
| Purpose | reserve the branded name so it can be used later |

## Background

The remote-access plugin is published as **`dsh-web-remote`** (a descriptive
name). **`dsh-whale-link`** is the branded name for the same product. Both
names should be kept available and published together in the future, so this
placeholder reserves the name before someone else takes it.

## Options under discussion

Once the loading strategy is settled, this package will become one of:

- **(a) Thin wrapper** — keep the implementation in `dsh-web-remote` and have
  this package re-export it (`export * from "dsh-web-remote"` plus its own
  `cordis.patch.yml`). No duplicated code; recommended.
- **(b) Full package** — move the implementation here.

## Do not install yet

`dsh plugin add dsh-whale-link` will fail until one of the options above is
implemented. Use `dsh-web-remote` in the meantime.
