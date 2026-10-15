import { afterEach, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { PostgresDatabase, type SqlPool } from '../src/postgres-db.js';
import { PostgresStore } from '../src/postgres-store.js';
import { buildApp } from '../src/app.js';
import { AgentPlanner, type ChatClient } from '../src/agent.js';
import { samplePlan, sampleRecords } from '../src/sample.js';

// PGlite runs the PostgreSQL engine locally. Its single connection is leased
// exclusively; production pg uses the advisory lock to serialize connections.
async function open(snapshot?: Blob) {
  const engine = new PGlite(snapshot ? { loadDataDir: snapshot } : {});
  await engine.waitReady;
  let tail = Promise.resolve();
  const pool: SqlPool = {
    async connect() {
      const previous = tail;
      let release!: () => void;
      tail = new Promise<void>((resolve) => { release = resolve; });
      await previous;
      return {
        async query(sql: string, values?: unknown[]) {
          if (sql.includes('pg_advisory_xact_lock')) return { rows: [], rowCount: 0 };
          if (values === undefined) {
            const results = await engine.exec(sql);
            const result = results.at(-1);
            return { rows: (result?.rows ?? []) as Record<string, unknown>[], rowCount: result?.affectedRows ?? 0 };
          }
          const result = await engine.query(sql, values);
          return { rows: result.rows as Record<string, unknown>[], rowCount: result.affectedRows ?? 0 };
        },
        release,
      };
    },
    async end() { await tail; await engine.close(); },
  };
  const db = new PostgresDatabase(pool);
  const store = await PostgresStore.open(db);
  return { store, db, snapshot: () => engine.dumpDataDir() };
}

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function setup() {
  const result = await open();
  cleanup.push(() => result.store.close());
  const dataset = await result.store.createDataset(sampleRecords);
  const plan = await result.store.createPlan(dataset.id, samplePlan);
  return { ...result, dataset, plan };
}

async function approve(store: PostgresStore, planId: string) {
  const run = await store.createDryRun(planId);
  await store.approve(planId, run.id, await store.approvalDigest(planId, run.id), 'test-reviewer', true);
  return run;
}

describe('hosted PostgreSQL workflow', () => {
  it('gates execution, executes once under concurrent retries, reconciles and rolls back', async () => {
    const { store, plan } = await setup();
    await expect(store.execute(plan.id)).rejects.toThrow('approved');
    const run = await store.createDryRun(plan.id);
    expect(run.result).toMatchObject({ source: 20, accepted: 14, rejected: 6 });
    const digest = await store.approvalDigest(plan.id, run.id);
    await expect(store.approve(plan.id, run.id, digest, 'reviewer', false)).rejects.toThrow('acknowledged');
    await expect(store.approve(plan.id, run.id, 'wrong', 'reviewer', true)).rejects.toThrow('stale');
    await store.approve(plan.id, run.id, digest, 'reviewer', true);
    const executions = await Promise.all([store.execute(plan.id), store.execute(plan.id)]);
    expect(executions[0].id).toBe(executions[1].id);
    expect(executions.map((execution) => execution.additionalInserts).sort((a, b) => a - b)).toEqual([0, 14]);
    expect(await store.targetCount()).toBe(14);
    expect((await store.reconcile(executions[0].id)).matched).toBe(true);
    expect((await store.retry(executions[0].id)).additionalInserts).toBe(0);
    expect((await store.rollback(executions[0].id)).deleted).toBe(14);
    expect((await store.rollback(executions[0].id)).deleted).toBe(0);
    await expect(store.execute(plan.id)).rejects.toThrow('rolled-back');
  }, 30_000);

  it('versions plans serially and blocks stale approvals and stale target state', async () => {
    const { store, plan, dataset } = await setup();
    const run = await approve(store, plan.id);
    const execution = await store.execute(plan.id);
    const versions = await Promise.all([store.createPlan(dataset.id, samplePlan), store.createPlan(dataset.id, samplePlan)]);
    expect(versions.map((version) => version.version)).toEqual([2, 3]);
    await expect(store.approve(plan.id, run.id, await store.approvalDigest(plan.id, run.id), 'reviewer', true)).rejects.toThrow('newer plan');
    await approve(store, versions[1].id);
    await store.rollback(execution.id);
    expect(await store.latestState()).toMatchObject({ approved: false, planNeedsRefresh: true });
    await expect(store.execute(versions[1].id)).rejects.toThrow('Target changed');
    const newer = await store.createDataset(sampleRecords);
    await expect(store.approve(versions[1].id, run.id, 'wrong', 'reviewer', true)).rejects.toThrow('newer dataset');
    expect((await store.latestState()).datasetId).toBe(newer.id);
  }, 30_000);

  it('rolls back partial inserts and retains a failed attempt outside the transaction', async () => {
    const { store, db, plan } = await setup();
    await approve(store, plan.id);
    await db.atomic(() => db.exec("ALTER TABLE target_records ADD CONSTRAINT synthetic_failure CHECK (target_key <> 'CUST-002')"));
    await expect(store.execute(plan.id)).rejects.toThrow('synthetic_failure');
    expect(await store.targetCount()).toBe(0);
    expect((await store.latestState()).executionId).toBeNull();
    const attempts = await db.atomic(() => db.prepare("SELECT outcome FROM attempts WHERE outcome = 'failed'").all());
    expect(attempts).toHaveLength(1);
    await db.atomic(() => db.exec('ALTER TABLE target_records DROP CONSTRAINT synthetic_failure'));
    expect((await store.execute(plan.id)).inserted).toBe(14);
  }, 30_000);

  it('restores plans, approval, execution and audit history from a persisted database snapshot', async () => {
    let store: PostgresStore | undefined;
    try {
      const original = await open();
      store = original.store;
      const dataset = await store.createDataset(sampleRecords);
      const plan = await store.createPlan(dataset.id, samplePlan);
      await approve(store, plan.id);
      const execution = await store.execute(plan.id);
      const history = await store.history();
      const snapshot = await original.snapshot();
      await store.close();
      store = undefined;
      store = (await open(snapshot)).store;
      expect(await store.latestState()).toMatchObject({ datasetId: dataset.id, planId: plan.id, approved: true, executionId: execution.id });
      expect(await store.history()).toEqual(history);
      expect((await store.retry(execution.id)).additionalInserts).toBe(0);
      expect((await store.reconcile(execution.id)).matched).toBe(true);
    } finally {
      await store?.close();
    }
  }, 30_000);

  it('serves the async repository through the API and AI inspection tools', async () => {
    const { store, dataset } = await setup();
    const client: ChatClient = {
      async complete(messages) {
        expect(messages[1]?.content).toContain('rowCount');
        return { model: 'fake-test-model', message: { content: JSON.stringify({
          plan: samplePlan, summary: 'Complete mapping',
          rationales: samplePlan.mappings.map(({ target, sources }) => ({ target, reason: 'Selected', evidence: sources.join(', ') })),
          risks: [], assumptions: [], questions: [{ field: 'email', question: 'Confirm emails?', blocking: true }],
        }) } };
      },
    };
    const app = buildApp(store, new AgentPlanner(store, client));
    cleanup.push(() => app.close());
    expect((await app.inject({ method: 'GET', url: '/api/state' })).statusCode).toBe(200);
    const response = await app.inject({ method: 'POST', url: `/api/datasets/${dataset.id}/proposals`, payload: {} });
    expect(response.statusCode).toBe(200);
    const result = response.json();
    expect(result.dryRun.result.accepted).toBe(14);
    const digest = await store.approvalDigest(result.planId, result.dryRun.id);
    await expect(store.approve(result.planId, result.dryRun.id, digest, 'reviewer', true)).rejects.toThrow('Blocking question');
    await store.approve(result.planId, result.dryRun.id, digest, 'reviewer', true, { email: 'Confirmed' });
    const execution = await app.inject({ method: 'POST', url: `/api/plans/${result.planId}/execute` });
    expect(execution.statusCode).toBe(200);
    expect(execution.json().inserted).toBe(14);
    expect((await app.inject({ method: 'GET', url: '/api/target' })).json().rows).toHaveLength(14);
  }, 30_000);
});
