/**
 * dsh-agent-mesh — cross-host agent mesh for DeepSeek Harness (DSH).
 *
 * ⚠️ PLACEHOLDER RELEASE (0.0.1)
 * This version only reserves the npm package name. There is no functionality yet:
 * calling into it throws on purpose, so a stray import or invocation fails loudly
 * instead of silently doing nothing.
 *
 * Design, requirements and decisions are maintained in the private repository.
 * This source file is part of the public placeholder package only.
 * Repository: https://github.com/floatinghotpot/remote-dsh
 */

/** Package status marker: readable without calling anything. */
export const STATUS = "placeholder" as const;

/** The npm package name this project publishes under. */
export const PACKAGE_NAME = "dsh-agent-mesh";

/**
 * Reserved entry point for the future agent-mesh API.
 *
 * @throws Always — 0.0.1 is a name reservation, not an implementation.
 */
export function createAgentMesh(): never {
  throw new Error(
    `${PACKAGE_NAME}@0.0.1 is a placeholder release: it only reserves the package name. ` +
      "See https://github.com/floatinghotpot/remote-dsh for the project; design docs are private.",
  );
}
