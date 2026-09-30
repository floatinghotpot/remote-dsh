/**
 * dsh-whale-link — name reservation package.
 *
 * This package currently reserves the npm name only; the implementation has
 * NOT been moved here yet. The working plugin lives in `dsh-web-remote`
 * (packages/web-remote), and both names refer to the same product.
 *
 * The loading strategy for this name is still under discussion:
 *   (a) re-export the implementation from `dsh-web-remote` (thin wrapper), or
 *   (b) carry the implementation itself.
 * Until that is decided, this module intentionally throws so that any accidental
 * `dsh plugin add dsh-whale-link` fails loudly instead of silently doing nothing.
 */

throw new Error(
  "dsh-whale-link is a name-reservation package and is not installable yet. " +
    "Use `dsh-web-remote` for now."
);
