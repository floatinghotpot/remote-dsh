/**
 * dsh-agent-mesh — cross-host agent mesh for DeepSeek Harness (DSH).
 *
 * ⚠️ PLACEHOLDER RELEASE (0.0.1)
 * This version only reserves the npm package name. There is no functionality yet:
 * calling into it throws on purpose, so a stray import or invocation fails loudly
 * instead of silently doing nothing.
 *
 * What it will be (design and status):
 *   doc/feature/21-agent-mesh/what-and-why.md  — what it is and why it is worth building
 *   doc/feature/21-agent-mesh/req.md           — requirements and acceptance criteria
 *   doc/feature/21-agent-mesh/discussion.md    — facts, decisions, implementation notes
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
      "See https://github.com/floatinghotpot/remote-dsh/tree/main/doc/feature/21-agent-mesh for the design.",
  );
}
