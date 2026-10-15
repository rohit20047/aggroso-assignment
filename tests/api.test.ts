import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { AgentPlanner, type ChatClient } from '../src/agent.js';
import { MigrationStore } from '../src/store.js';
import { samplePlan, sampleRecords } from '../src/sample.js';

describe('reviewer API', () => {
  it('accepts a dynamic migration input snapshot and exposes its selected rules', async () => {
    const store = new MigrationStore(':memory:');
    const app = buildApp(store);
    try {
      const input = {
        sourceSchema: [{ field: 'old_code', type: 'string', required: true }],
        targetSchema: [{ field: 'new_code', type: 'string', required: true, unique: true }],
        records: [{ old_code: ' X ' }],
        allowedRules: ['trim'],
      };
      const created = await app.inject({ method: 'POST', url: '/api/datasets', payload: input });
      expect(created.statusCode).toBe(200);
      const id = (created.json() as { id: string }).id;
      const schemas = await app.inject({ method: 'GET', url: `/api/datasets/${id}/schemas` });
      expect(schemas.json()).toMatchObject({ source: input.sourceSchema, target: input.targetSchema });
      const plan = store.createPlan(id, { mappings: [{ target: 'new_code', sources: ['old_code'], rule: 'trim' }] });
      expect(store.createDryRun(plan.id).result.accepted).toBe(1);
      expect((await app.inject({ method: 'GET', url: '/api/rules' })).json()).toHaveProperty('rules');
    } finally {
      await app.close();
      store.close();
    }
  });

  it('returns the AI-selected plan and automatic dry run without executing', async () => {
    const store = new MigrationStore(':memory:');
    const client: ChatClient = {
      async complete() {
        return { model: 'fake-test-model', message: { content: JSON.stringify({ plan: samplePlan, summary: 'Complete mapping', rationales: samplePlan.mappings.map(({ target, sources }) => ({ target, reason: 'Selected by AI', evidence: sources.join(', ') })), risks: [], assumptions: [], questions: [] }) } };
      },
    };
    const app = buildApp(store, undefined, new AgentPlanner(store, client));
    try {
      const dataset = store.createDataset(sampleRecords);
      const response = await app.inject({ method: 'POST', url: `/api/datasets/${dataset.id}/proposals`, payload: {} });
      expect(response.statusCode).toBe(200);
      const result = response.json() as { planId: string; planVersion: number; dryRun: { result: { source: number; accepted: number; rejected: number } } };
      expect(result.planVersion).toBe(1);
      expect(result.dryRun.result).toMatchObject({ source: 20, accepted: 14, rejected: 6 });
      expect(store.targetCount()).toBe(0);
    } finally {
      await app.close();
      store.close();
    }
  });

  it('enforces reviewer access and approval before executing', async () => {
    const store = new MigrationStore(':memory:');
    const app = buildApp(store, 'test-only-secret');
    const headers = { 'x-reviewer-key': 'test-only-secret' };
    try {
      const unauthorized = await app.inject({ method: 'GET', url: '/api/history' });
      expect(unauthorized.statusCode).toBe(401);
      for (const key of ['', 'wrong-key', ' test-only-secret ']) {
        const denied = await app.inject({ method: 'GET', url: '/api/state', headers: { 'x-reviewer-key': key } });
        expect(denied.statusCode).toBe(401);
      }
      expect((await app.inject({ method: 'GET', url: '/api/state', headers })).statusCode).toBe(200);

      const datasetResponse = await app.inject({ method: 'POST', url: '/api/datasets', headers, payload: { records: sampleRecords } });
      expect(datasetResponse.statusCode).toBe(200);
      const dataset = datasetResponse.json() as { id: string };
      const planResponse = await app.inject({ method: 'POST', url: `/api/datasets/${dataset.id}/plans`, headers, payload: { plan: samplePlan } });
      expect(planResponse.statusCode).toBe(200);
      const plan = planResponse.json() as { id: string };

      const blocked = await app.inject({ method: 'POST', url: `/api/plans/${plan.id}/execute`, headers });
      expect(blocked.statusCode).toBe(409);
      expect(store.targetCount()).toBe(0);

      const runResponse = await app.inject({ method: 'POST', url: `/api/plans/${plan.id}/dry-runs`, headers });
      const run = runResponse.json() as { id: string; result: { accepted: number; rejected: number } };
      expect(run.result).toMatchObject({ accepted: 14, rejected: 6 });

      const digestResponse = await app.inject({ method: 'GET', url: `/api/plans/${plan.id}/approval-digest?dryRunId=${run.id}`, headers });
      const approvalDigest = (digestResponse.json() as { digest: string }).digest;
      const approval = await app.inject({ method: 'POST', url: `/api/plans/${plan.id}/approve`, headers, payload: { dryRunId: run.id, digest: approvalDigest, actor: 'test-reviewer', acknowledgeRejected: true } });
      expect(approval.statusCode).toBe(200);

      const execution = await app.inject({ method: 'POST', url: `/api/plans/${plan.id}/execute`, headers });
      expect(execution.statusCode).toBe(200);
      const result = execution.json() as { id: string; inserted: number };
      expect(result.inserted).toBe(14);

      const retry = await app.inject({ method: 'POST', url: `/api/executions/${result.id}/retry`, headers });
      expect(retry.json()).toMatchObject({ additionalInserts: 0 });

      const reconciliation = await app.inject({ method: 'GET', url: `/api/executions/${result.id}/reconciliation`, headers });
      expect(reconciliation.json()).toMatchObject({ matched: true, ownedCount: 14 });

      const rollback = await app.inject({ method: 'POST', url: `/api/executions/${result.id}/rollback`, headers });
      expect(rollback.json()).toMatchObject({ deleted: 14, targetCount: 0 });
    } finally {
      await app.close();
      store.close();
    }
  });
});
