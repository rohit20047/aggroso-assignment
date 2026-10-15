import type { MigrationStore } from './store.js';

/** Both local SQLite and hosted PostgreSQL expose the same workflow operations. */
export type MigrationRepository = {
  [K in keyof MigrationStore as MigrationStore[K] extends (...args: never[]) => unknown ? K : never]:
    MigrationStore[K] extends (...args: infer A) => infer R ? (...args: A) => R | Promise<R> : never;
};
