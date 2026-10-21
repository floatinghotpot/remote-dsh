import type { HubDb } from "./db.ts";

/** 把同步方法签名映射为异步（返回 Promise）。 */
type Asyncify<F> = F extends (...args: infer A) => infer R ? (...args: A) => Promise<Awaited<R>> : never;

/**
 * 43-hub-postgres 43a：Hub 数据访问的异步接口。
 *
 * 只暴露 `HubDb` 的**方法**（不含 `db`/`path` 等属性）；SQLite 实现由
 * `createSqliteStore` 用 Proxy 包装，PG 实现见 `pg-store/index.ts`。
 * 另附 `withTransaction`：把多语句写包成一个事务（SQLite 传 `HubDb`，PG 传 `PoolClient`）。
 */
export type HubStore = {
  [K in keyof HubDb as HubDb[K] extends (...args: any[]) => any ? K : never]: Asyncify<HubDb[K]>;
} & {
  // tx 类型在两端不同（HubDb / PoolClient），故用 unknown；事务体通过 store 自身方法访问数据。
  withTransaction<T>(fn: (tx: unknown) => Promise<T> | T): Promise<T>;
};

/** 用现有同步 `HubDb` 生成异步 store（43a：行为不变，仅把调用面 Promise 化）。 */
export function createSqliteStore(db: HubDb): HubStore {
  const proxy = new Proxy(db, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => Promise.resolve((value as (...a: unknown[]) => unknown).apply(target, args));
    },
  }) as unknown as HubStore;
  return Object.assign(proxy, {
    withTransaction: async <T,>(fn: (tx: unknown) => Promise<T> | T): Promise<T> => {
      db.db.exec("BEGIN");
      try {
        const result = await fn(db);
        db.db.exec("COMMIT");
        return result;
      } catch (err) {
        db.db.exec("ROLLBACK");
        throw err;
      }
    },
  });
}
