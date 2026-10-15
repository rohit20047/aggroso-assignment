import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { MigrationStore } from '../src/store.js';
import { samplePlan, sampleRecords } from '../src/sample.js';

const stores: MigrationStore[] = [];

function setup() {
  const store = new MigrationStore(':memory:');
  stores.push(store);
  const dataset = store.createDataset(sampleRecords);
  const plan = store.createPlan(dataset.id, samplePlan);
  return { store, dataset, plan };
}

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

describe('migration persistence and approval gate', () => {
  it('migrates user-defined schemas and selected rules into the generic mock target', () => {
    const store = new MigrationStore(':memory:');
    stores.push(store);
    const input = {
      sourceSchema: [
        { field: 'legacy_key', type: 'string', required: true },
        { field: 'contact', type: 'string', required: true },
        { field: 'seats', type: 'integer', required: true },
      ],
      targetSchema: [
        { field: 'account_id', type: 'string', required: true, unique: true },
        { field: 'email', type: 'string', required: true, format: 'email' },
        { field: 'seat_count', type: 'integer', required: true },
      ],
      records: [
        { legacy_key: ' A-1 ', contact: 'ONE@EXAMPLE.TEST', seats: 3 },
        { legacy_key: 'A-2', contact: 'bad-email', seats: 2 },
      ],
      allowedRules: ['trim', 'trim_lower', 'identity'],
    };
    const dataset = store.createDataset(input);
    expect(store.getDataset(dataset.id).input.targetSchema[0]?.field).toBe('account_id');
    const plan = store.createPlan(dataset.id, { mappings: [
      { target: 'account_id', sources: ['legacy_key'], rule: 'trim' },
      { target: 'email', sources: ['contact'], rule: 'trim_lower' },
      { target: 'seat_count', sources: ['seats'], rule: 'identity' },
    ] });
    const run = store.createDryRun(plan.id);
    expect(run.result).toMatchObject({ source: 2, accepted: 1, rejected: 1 });
    expect(run.result.rows[1]?.errors.some((error) => error.field === 'email')).toBe(true);
    store.approve(plan.id, run.id, store.approvalDigest(plan.id, run.id), 'reviewer', true);
    const execution = store.execute(plan.id);
    expect(store.targetRows()[0]).toMatchObject({ account_id: 'A-1', email: 'one@example.test', seat_count: 3 });
    expect(store.retry(execution.id).additionalInserts).toBe(0);
    expect(store.reconcile(execution.id).matched).toBe(true);
    expect(store.rollback(execution.id).deleted).toBe(1);
  });

  it('requires approval, then executes once, reconciles, and rolls back', () => {
    const { store, plan } = setup();
    expect(() => store.execute(plan.id)).toThrow('approved');
    expect(store.targetCount()).toBe(0);

    const run = store.createDryRun(plan.id);
    const digest = store.approvalDigest(plan.id, run.id);
    expect(() => store.approve(plan.id, run.id, digest, 'reviewer', false)).toThrow('acknowledged');
    store.approve(plan.id, run.id, digest, 'reviewer', true);
    const repeatedRun = store.createDryRun(plan.id);
    store.approve(plan.id, repeatedRun.id, store.approvalDigest(plan.id, repeatedRun.id), 'reviewer', true);
    expect((store.history() as { action: string }[]).some((event) => event.action === 'approval_replayed')).toBe(true);

    const first = store.execute(plan.id);
    expect(first.inserted).toBe(14);
    expect(first.additionalInserts).toBe(14);
    expect(store.targetCount()).toBe(14);
    expect(store.reconcile(first.id).matched).toBe(true);

    const retry = store.execute(plan.id);
    expect(retry.id).toBe(first.id);
    expect(retry.additionalInserts).toBe(0);
    expect(store.targetCount()).toBe(14);

    expect(store.rollback(first.id).deleted).toBe(14);
    expect(store.targetCount()).toBe(0);
    expect(store.rollback(first.id).deleted).toBe(0);
    expect(() => store.execute(plan.id)).toThrow('rolled-back');
    expect(store.history().length).toBeGreaterThan(5);
  });

  it('rejects stale approval digests', () => {
    const { store, plan } = setup();
    const run = store.createDryRun(plan.id);
    expect(() => store.approve(plan.id, run.id, 'wrong', 'reviewer', true)).toThrow('stale');
  });

  it('keeps plan versions immutable', () => {
    const { store, dataset, plan } = setup();
    const run = store.createDryRun(plan.id);
    const second = store.createPlan(dataset.id, samplePlan);
    expect(plan.version).toBe(1);
    expect(second.version).toBe(2);
    expect(store.listPlans(dataset.id).map((version) => version.version)).toEqual([2, 1]);
    expect(store.getPlan(plan.id).version).toBe(1);
    expect(() => store.approve(plan.id, run.id, store.approvalDigest(plan.id, run.id), 'reviewer', true))
      .toThrow('newer plan');
  });

  it('restores the committed migration and audit history after a database restart', () => {
    const directory = mkdtempSync(join(tmpdir(), 'migration-workbench-test-'));
    const databasePath = join(directory, 'test.db');
    try {
      let store = new MigrationStore(databasePath);
      const dataset = store.createDataset(sampleRecords);
      const plan = store.createPlan(dataset.id, samplePlan);
      const run = store.createDryRun(plan.id);
      store.approve(plan.id, run.id, store.approvalDigest(plan.id, run.id), 'reviewer', true);
      const execution = store.execute(plan.id);
      store.close();

      store = new MigrationStore(databasePath);
      expect(store.latestState()).toMatchObject({ datasetId: dataset.id, planId: plan.id, executionId: execution.id, executionStatus: 'committed', activeExecutionId: execution.id, activeExecutionDatasetId: dataset.id });
      expect(store.targetCount()).toBe(14);
      expect(store.execute(plan.id).additionalInserts).toBe(0);
      expect(store.reconcile(execution.id).matched).toBe(true);
      expect(store.history().length).toBeGreaterThan(4);
      const newerDataset = store.createDataset(sampleRecords);
      const newerPlan = store.createPlan(newerDataset.id, samplePlan);
      const newerRun = store.createDryRun(newerPlan.id);
      store.approve(newerPlan.id, newerRun.id, store.approvalDigest(newerPlan.id, newerRun.id), 'reviewer', true);
      expect(store.latestState()).toMatchObject({ datasetId: newerDataset.id, executionId: null, activeExecutionId: execution.id, activeExecutionDatasetId: dataset.id });
      store.rollback(execution.id);
      expect(store.latestState()).toMatchObject({ planId: newerPlan.id, approved: false, planNeedsRefresh: true, activeExecutionId: null });
      store.close();
    } finally {
      if (resolve(dirname(directory)) !== resolve(tmpdir())) throw new Error('Refusing to remove a directory outside the temporary root');
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('rolls back an interrupted insertion atomically and records the failed attempt', () => {
    const { store, plan } = setup();
    const run = store.createDryRun(plan.id);
    store.approve(plan.id, run.id, store.approvalDigest(plan.id, run.id), 'reviewer', true);
    store.db.exec("CREATE TRIGGER fail_second BEFORE INSERT ON target_records WHEN NEW.target_key = 'CUST-002' BEGIN SELECT RAISE(ABORT, 'synthetic insert failure'); END");
    expect(() => store.execute(plan.id)).toThrow('synthetic insert failure');
    expect(store.targetCount()).toBe(0);
    expect(store.latestState().executionId).toBeNull();
    store.db.exec('DROP TRIGGER fail_second');
    expect(store.execute(plan.id).inserted).toBe(14);
  });
});
