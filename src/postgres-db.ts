import { AsyncLocalStorage } from 'node:async_hooks';
import { Pool } from 'pg';

export interface SqlConnection {
  query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
  release(): void;
}

export interface SqlPool {
  connect(): Promise<SqlConnection>;
  end(): Promise<void>;
}

/** Each workflow operation uses one connection and a transaction-scoped lock.
 * This preserves the single-workbench semantics even during overlapping deploys.
 * No connection or lock is held while waiting for an LLM response.
 */
export class PostgresDatabase {
  private readonly context = new AsyncLocalStorage<SqlConnection>();
  constructor(private readonly pool: SqlPool) {}

  inTransaction(): boolean { return Boolean(this.context.getStore()); }

  static connect(connectionString: string): PostgresDatabase {
    const pool = new Pool({
      connectionString, max: 3, connectionTimeoutMillis: 30_000, idleTimeoutMillis: 10_000,
    });
    pool.on('error', () => console.error('Idle PostgreSQL connection closed; pool will reconnect'));
    return new PostgresDatabase(pool);
  }

  async atomic<T>(operation: () => Promise<T>): Promise<T> {
    if (this.context.getStore()) return operation();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout = '30s'");
      await client.query("SET LOCAL statement_timeout = '30s'");
      await client.query('SELECT pg_advisory_xact_lock(74190213)');
      const result = await this.context.run(client, operation);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async exec(sql: string): Promise<void> {
    const client = this.context.getStore();
    if (!client) throw new Error('Database operation requires a transaction');
    await client.query(sql);
  }

  prepare(sql: string) {
    let index = 0;
    const statement = sql.replace(/\?/g, () => `$${++index}`);
    const query = async (values: unknown[]) => {
      const client = this.context.getStore();
      if (!client) throw new Error('Database operation requires a transaction');
      return client.query(statement, values);
    };
    return {
      get: async (...values: unknown[]) => (await query(values)).rows[0],
      all: async (...values: unknown[]) => (await query(values)).rows,
      run: async (...values: unknown[]) => ({ changes: (await query(values)).rowCount ?? 0 }),
    };
  }

  transaction<T>(operation: () => Promise<T>) {
    return { immediate: () => this.atomic(operation) };
  }

  close(): Promise<void> { return this.pool.end(); }
}
