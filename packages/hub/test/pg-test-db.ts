/**
 * 测试库护栏（2026-10-25 生产反馈）：
 * 破坏性测试（DROP SCHEMA / DELETE）只允许跑在测试库上。
 * 命名约定：库名必须以 `test_` 开头或以 `_test` 结尾；生产库 `rdsh` 等其它名字一律拒绝。
 */

/** 从 DSN 解出库名（`postgres://…/rdsh_test` → `rdsh_test`）。 */
export function testDbName(dsn: string): string {
  return new URL(dsn).pathname.replace(/^\//, "");
}

/** 是否测试库：`test_` 前缀 或 `_test` 后缀。 */
export function isTestDb(dsn: string): boolean {
  const name = testDbName(dsn);
  return name.startsWith("test_") || name.endsWith("_test");
}

/** DROP/DELETE 前二次断言：不是测试库就直接抛错，绝不执行破坏性操作。 */
export function assertTestDb(dsn: string): string {
  const name = testDbName(dsn);
  if (!name.startsWith("test_") && !name.endsWith("_test")) {
    throw new Error(`refusing destructive operation on non-test database: ${name}`);
  }
  return name;
}
