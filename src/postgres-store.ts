import { PostgresDatabase } from './postgres-db.js';
import type { MigrationRepository } from './repository.js';
// Hosted counterpart of the local SQLite store; workflow parity is checked by integration tests.
const schema = `
      CREATE TABLE IF NOT EXISTS datasets (
        id TEXT PRIMARY KEY, records_json TEXT NOT NULL, hash TEXT NOT NULL, created_at TEXT NOT NULL, sequence_no BIGINT GENERATED ALWAYS AS IDENTITY
      );
      CREATE TABLE IF NOT EXISTS plans (
        id TEXT PRIMARY KEY, dataset_id TEXT NOT NULL REFERENCES datasets(id), version INTEGER NOT NULL,
        plan_json TEXT NOT NULL, hash TEXT NOT NULL, created_at TEXT NOT NULL,
        UNIQUE(dataset_id, version)
      );
      CREATE TABLE IF NOT EXISTS dry_runs (
        id TEXT PRIMARY KEY, plan_id TEXT NOT NULL REFERENCES plans(id), result_json TEXT NOT NULL,
        target_hash TEXT NOT NULL, created_at TEXT NOT NULL, sequence_no BIGINT GENERATED ALWAYS AS IDENTITY
      );
      CREATE TABLE IF NOT EXISTS approvals (
        plan_id TEXT PRIMARY KEY REFERENCES plans(id), dry_run_id TEXT NOT NULL REFERENCES dry_runs(id),
        digest TEXT NOT NULL, actor TEXT NOT NULL, answers_json TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS proposals (
        plan_id TEXT PRIMARY KEY REFERENCES plans(id), proposal_json TEXT NOT NULL,
        model TEXT NOT NULL, tool_names_json TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS llm_runs (
        id TEXT PRIMARY KEY, dataset_id TEXT NOT NULL REFERENCES datasets(id), model TEXT NOT NULL,
        status TEXT NOT NULL, tool_names_json TEXT NOT NULL, duration_ms INTEGER NOT NULL,
        error_code TEXT, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS executions (
        id TEXT PRIMARY KEY, plan_id TEXT NOT NULL UNIQUE REFERENCES plans(id), status TEXT NOT NULL,
        result_json TEXT NOT NULL, baseline_count INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS attempts (
        id TEXT PRIMARY KEY, plan_id TEXT NOT NULL REFERENCES plans(id), execution_id TEXT,
        action TEXT NOT NULL, outcome TEXT NOT NULL, detail TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS target_customers (
        customer_id TEXT PRIMARY KEY, full_name TEXT NOT NULL, email TEXT NOT NULL,
        status TEXT NOT NULL, created_at_utc TEXT NOT NULL, spend_minor INTEGER NOT NULL,
        country_code TEXT NOT NULL, execution_id TEXT NOT NULL REFERENCES executions(id)
      );
      CREATE TABLE IF NOT EXISTS target_records (
        target_key TEXT PRIMARY KEY, record_json TEXT NOT NULL, schema_hash TEXT NOT NULL,
        execution_id TEXT NOT NULL REFERENCES executions(id)
      );
      CREATE TABLE IF NOT EXISTS audit_events (
        id TEXT PRIMARY KEY, action TEXT NOT NULL, entity_id TEXT NOT NULL,
        detail_json TEXT NOT NULL, created_at TEXT NOT NULL, sequence_no BIGINT GENERATED ALWAYS AS IDENTITY
      );
    
ALTER TABLE datasets ADD COLUMN IF NOT EXISTS input_json TEXT;` ;
import { createHash, randomUUID } from 'node:crypto';
import { dryRun, sampleAllowedRules, sampleSourceSchema, sampleTargetSchema, validateInput, validatePlan, type DryRunResult, type MigrationInput, type Plan, type SourceRecord, type TargetRecord } from './domain.js';
const RULE_VERSION = 'bounded-rules-v2';
function digest(value: unknown): string {
    return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
interface DatasetRow {
    id: string;
    records_json: string;
    input_json: string | null;
    hash: string;
}
interface PlanRow {
    id: string;
    dataset_id: string;
    version: number;
    plan_json: string;
    hash: string;
}
interface DryRunRow {
    id: string;
    plan_id: string;
    result_json: string;
    target_hash: string;
}
interface ApprovalRow {
    plan_id: string;
    dry_run_id: string;
    digest: string;
}
interface ExecutionRow {
    id: string;
    plan_id: string;
    status: string;
    result_json: string;
    baseline_count: number;
}
export class PostgresStore implements MigrationRepository {
  private constructor(private readonly db: PostgresDatabase) {}

  static async open(database: string | PostgresDatabase): Promise<PostgresStore> {
    const db = typeof database === 'string' ? PostgresDatabase.connect(database) : database;
    const store = new PostgresStore(db);
    try {
      await db.atomic(() => db.exec(schema));
    } catch (error) { await db.close(); throw error; }
    // Wrap public operations so all reads/checks/writes share one transaction.
    for (const name of ["createDataset","getDataset","createPlan","getPlan","listPlans","recordProposal","getProposal","recordLLMRun","createDryRun","getDryRun","approvalDigest","approve","execute","reconcile","rollback","targetCount","targetRows","retry","history","latestState"]) {
      const methods = store as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
      const method = methods[name]!.bind(store);
      methods[name] = async (...args) => {
        try { return await db.atomic(() => method(...args)); }
        catch (error) {
          if ((name === 'execute' || name === 'retry') && !db.inTransaction()) {
            const detail = error instanceof Error ? error.message : 'Execution failed';
            await db.atomic(async () => {
              const plan = name === 'execute'
                ? await db.prepare('SELECT id FROM plans WHERE id = ?').get(args[0])
                : await db.prepare('SELECT plan_id AS id FROM executions WHERE id = ?').get(args[0]);
              if (plan) await store.attempt(String(plan.id), null, name, 'failed', detail);
            }).catch(() => undefined);
          }
          throw error;
        }
      };
    }
    return store;
  }

  close(): Promise<void> { return this.db.close(); }
    private async audit(action: string, entityId: string, detail: unknown): Promise<void> {
        await this.db.prepare('INSERT INTO audit_events VALUES (?, ?, ?, ?, ?)')
            .run(randomUUID(), action, entityId, JSON.stringify(detail), new Date().toISOString());
    }
    private async attempt(planId: string, executionId: string | null, action: string, outcome: string, detail: string): Promise<void> {
        await this.db.prepare('INSERT INTO attempts VALUES (?, ?, ?, ?, ?, ?, ?)')
            .run(randomUUID(), planId, executionId, action, outcome, detail, new Date().toISOString());
    }
    async createDataset(input: unknown): Promise<{
        id: string;
        count: number;
        hash: string;
    }> {
        const spec = validateInput(Array.isArray(input) ? { sourceSchema: sampleSourceSchema, targetSchema: sampleTargetSchema, records: input, allowedRules: sampleAllowedRules } : input);
        const id = randomUUID();
        const hash = digest(spec);
        await this.db.prepare('INSERT INTO datasets (id, records_json, hash, created_at, input_json) VALUES (?, ?, ?, ?, ?)')
            .run(id, JSON.stringify(spec.records), hash, new Date().toISOString(), JSON.stringify(spec));
        await this.audit('dataset_created', id, { count: spec.records.length, hash });
        return { id, count: spec.records.length, hash };
    }
    async getDataset(id: string): Promise<{
        id: string;
        records: SourceRecord[];
        input: MigrationInput;
        hash: string;
    }> {
        const row = await this.db.prepare('SELECT * FROM datasets WHERE id = ?').get(id) as DatasetRow | undefined;
        if (!row)
            throw new Error('Dataset not found');
        const records = JSON.parse(row.records_json) as SourceRecord[];
        const input = row.input_json ? JSON.parse(row.input_json) as MigrationInput : validateInput({ sourceSchema: sampleSourceSchema, targetSchema: sampleTargetSchema, records, allowedRules: sampleAllowedRules });
        return { id, records, input, hash: row.hash };
    }
    async createPlan(datasetId: string, input: unknown): Promise<{
        id: string;
        version: number;
        hash: string;
        plan: Plan;
    }> {
        const dataset = await this.getDataset(datasetId);
        const plan = validatePlan(input, dataset.input);
        const next = await this.db.prepare('SELECT COALESCE(MAX(version), 0) + 1 AS next FROM plans WHERE dataset_id = ?')
            .get(datasetId) as {
            next: number;
        };
        const id = randomUUID();
        const hash = digest({ plan, datasetHash: dataset.hash, ruleVersion: RULE_VERSION });
        await this.db.prepare('INSERT INTO plans VALUES (?, ?, ?, ?, ?, ?)')
            .run(id, datasetId, next.next, JSON.stringify(plan), hash, new Date().toISOString());
        await this.audit('plan_created', id, { datasetId, version: next.next, hash });
        return { id, version: next.next, hash, plan };
    }
    async getPlan(id: string): Promise<{
        id: string;
        datasetId: string;
        version: number;
        plan: Plan;
        hash: string;
    }> {
        const row = await this.db.prepare('SELECT * FROM plans WHERE id = ?').get(id) as PlanRow | undefined;
        if (!row)
            throw new Error('Plan not found');
        return { id, datasetId: row.dataset_id, version: row.version, plan: JSON.parse(row.plan_json) as Plan, hash: row.hash };
    }
    async listPlans(datasetId: string): Promise<{
        id: string;
        version: number;
        createdAt: string;
    }[]> {
        await this.getDataset(datasetId);
        return (await this.db.prepare('SELECT id, version, created_at FROM plans WHERE dataset_id = ? ORDER BY version DESC').all(datasetId) as {
            id: string;
            version: number;
            created_at: string;
        }[])
            .map((row) => ({ id: row.id, version: row.version, createdAt: row.created_at }));
    }
    async recordProposal(planId: string, proposal: unknown, model: string, toolNames: string[]): Promise<void> {
        await this.db.prepare('INSERT INTO proposals VALUES (?, ?, ?, ?, ?)')
            .run(planId, JSON.stringify(proposal), model, JSON.stringify(toolNames), new Date().toISOString());
        await this.audit('ai_proposal_saved', planId, { model, toolNames });
    }
    async getProposal(planId: string): Promise<unknown | null> {
        const row = await this.db.prepare('SELECT proposal_json FROM proposals WHERE plan_id = ?').get(planId) as {
            proposal_json: string;
        } | undefined;
        return row ? JSON.parse(row.proposal_json) : null;
    }
    async recordLLMRun(datasetId: string, model: string, status: 'success' | 'failure', toolNames: string[], durationMs: number, errorCode: string | null): Promise<void> {
        await this.db.prepare('INSERT INTO llm_runs VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
            .run(randomUUID(), datasetId, model, status, JSON.stringify(toolNames), durationMs, errorCode, new Date().toISOString());
    }
    private async ensureCurrentPlan(planId: string): Promise<void> {
        const plan = await this.getPlan(planId);
        const latestDataset = await this.db.prepare('SELECT id FROM datasets ORDER BY created_at DESC, sequence_no DESC LIMIT 1').get() as {
            id: string;
        };
        if (latestDataset.id !== plan.datasetId)
            throw new Error('A newer dataset snapshot requires a new plan');
        const latestPlan = await this.db.prepare('SELECT id FROM plans WHERE dataset_id = ? ORDER BY version DESC LIMIT 1')
            .get(plan.datasetId) as {
            id: string;
        };
        if (latestPlan.id !== planId)
            throw new Error('A newer plan version requires a new dry run and approval');
    }
    private async targetIds(): Promise<Set<string>> {
        return new Set((await this.db.prepare('SELECT target_key FROM target_records ORDER BY target_key').all() as {
            target_key: string;
        }[])
            .map((row) => row.target_key));
    }
    private async targetHash(): Promise<string> { return digest(await this.targetRows()); }
    async createDryRun(planId: string): Promise<{
        id: string;
        result: DryRunResult;
        targetHash: string;
    }> {
        const plan = await this.getPlan(planId);
        const dataset = await this.getDataset(plan.datasetId);
        const occupied = await this.targetIds();
        const result = dryRun(dataset.records, plan.plan, occupied, dataset.input);
        const targetHash = await this.targetHash();
        const id = randomUUID();
        await this.db.prepare('INSERT INTO dry_runs VALUES (?, ?, ?, ?, ?)')
            .run(id, planId, JSON.stringify(result), targetHash, new Date().toISOString());
        await this.audit('dry_run_created', id, { planId, source: result.source, accepted: result.accepted, rejected: result.rejected });
        return { id, result, targetHash };
    }
    async getDryRun(id: string): Promise<{
        id: string;
        planId: string;
        result: DryRunResult;
        targetHash: string;
    }> {
        const row = await this.db.prepare('SELECT * FROM dry_runs WHERE id = ?').get(id) as DryRunRow | undefined;
        if (!row)
            throw new Error('Dry run not found');
        return { id, planId: row.plan_id, result: JSON.parse(row.result_json) as DryRunResult, targetHash: row.target_hash };
    }
    async approvalDigest(planId: string, dryRunId: string): Promise<string> {
        const plan = await this.getPlan(planId);
        const dataset = await this.getDataset(plan.datasetId);
        const run = await this.getDryRun(dryRunId);
        if (run.planId !== planId)
            throw new Error('Dry run does not belong to this plan');
        return digest({ planHash: plan.hash, datasetHash: dataset.hash, targetHash: run.targetHash, dryRunId, ruleVersion: RULE_VERSION });
    }
    async approve(planId: string, dryRunId: string, submittedDigest: string, actor: string, acknowledgeRejected: boolean, answers: Record<string, string> = {}): Promise<void> {
        await this.ensureCurrentPlan(planId);
        const run = await this.getDryRun(dryRunId);
        if (run.planId !== planId)
            throw new Error('Dry run does not belong to this plan');
        if (run.result.rejected > 0 && !acknowledgeRejected)
            throw new Error('Rejected records must be acknowledged');
        if (await this.targetHash() !== run.targetHash)
            throw new Error('Target changed since the dry run');
        const expected = await this.approvalDigest(planId, dryRunId);
        if (submittedDigest !== expected)
            throw new Error('Approval content is stale');
        await this.db.transaction(async () => {
            const prior = await this.db.prepare('SELECT * FROM approvals WHERE plan_id = ?').get(planId) as ApprovalRow | undefined;
            if (prior) {
                const priorRun = await this.getDryRun(prior.dry_run_id);
                if (priorRun.targetHash !== run.targetHash || digest(priorRun.result) !== digest(run.result)) {
                    throw new Error('This plan already has an approval for a different dry run; save a new plan version');
                }
                await this.audit('approval_replayed', planId, { dryRunId, actor });
                return;
            }
            const proposal = await this.getProposal(planId) as {
                questions?: {
                    field: string;
                    blocking: boolean;
                }[];
            } | null;
            for (const question of proposal?.questions ?? []) {
                if (question.blocking && !answers[question.field]?.trim())
                    throw new Error(`Blocking question for ${question.field} must be answered`);
            }
            await this.db.prepare('INSERT INTO approvals VALUES (?, ?, ?, ?, ?, ?)')
                .run(planId, dryRunId, expected, actor, JSON.stringify(answers), new Date().toISOString());
            await this.audit('plan_approved', planId, { dryRunId, actor, rejected: run.result.rejected, answeredFields: Object.keys(answers) });
        }).immediate();
    }
    async execute(planId: string): Promise<{
        id: string;
        status: string;
        inserted: number;
        additionalInserts: number;
        baselineCount: number;
        targetCount: number;
    }> {
            return await this.db.transaction(async () => {
                const previous = await this.db.prepare('SELECT * FROM executions WHERE plan_id = ?').get(planId) as ExecutionRow | undefined;
                if (previous) {
                    if (previous.status !== 'committed')
                        throw new Error('A rolled-back migration requires a new plan and approval');
                    const stored = JSON.parse(previous.result_json) as {
                        inserted: number;
                        targetCount: number;
                    };
                    await this.attempt(planId, previous.id, 'retry', 'replayed', 'Existing committed execution returned');
                    await this.audit('execution_retried', previous.id, { additionalInserts: 0 });
                    return { id: previous.id, status: previous.status, inserted: stored.inserted, additionalInserts: 0, baselineCount: previous.baseline_count, targetCount: stored.targetCount };
                }
                const approval = await this.db.prepare('SELECT * FROM approvals WHERE plan_id = ?').get(planId) as ApprovalRow | undefined;
                if (!approval)
                    throw new Error('Plan must be approved before execution');
                await this.ensureCurrentPlan(planId);
                if (approval.digest !== await this.approvalDigest(planId, approval.dry_run_id))
                    throw new Error('Approval content is stale');
                const run = await this.getDryRun(approval.dry_run_id);
                if (await this.targetHash() !== run.targetHash)
                    throw new Error('Target changed since approval');
                const active = await this.db.prepare("SELECT id FROM executions WHERE status = 'committed'").get();
                if (active)
                    throw new Error('Rollback the active migration before executing another plan');
                const plan = await this.getPlan(planId);
                const dataset = await this.getDataset(plan.datasetId);
                const rerun = dryRun(dataset.records, plan.plan, await this.targetIds(), dataset.input);
                if (digest(rerun) !== digest(run.result))
                    throw new Error('Dry-run result is stale');
                const baselineCount = await this.targetCount();
                const id = randomUUID();
                const now = new Date().toISOString();
                await this.db.prepare('INSERT INTO executions VALUES (?, ?, ?, ?, ?, ?, ?)')
                    .run(id, planId, 'pending', '{}', baselineCount, now, now);
                const uniqueField = dataset.input.targetSchema.find((field) => field.unique)!.field;
                const schemaHash = digest(dataset.input.targetSchema);
                const acceptedRows = rerun.rows.filter((row) => row.accepted);
                if (acceptedRows.length > 0) {
                    const placeholders = acceptedRows.map(() => '(?, ?, ?, ?)').join(', ');
                    const values = acceptedRows.flatMap(({ transformed }) =>
                        [String(transformed[uniqueField]), JSON.stringify(transformed), schemaHash, id]);
                    await this.db.prepare(`INSERT INTO target_records (target_key, record_json, schema_hash, execution_id) VALUES ${placeholders}`).run(...values);
                }
                const targetCount = await this.targetCount();
                const result = { inserted: rerun.accepted, targetCount };
                await this.db.prepare("UPDATE executions SET status = 'committed', result_json = ?, updated_at = ? WHERE id = ?")
                    .run(JSON.stringify(result), now, id);
                await this.attempt(planId, id, 'execute', 'committed', `Inserted ${rerun.accepted}`);
                await this.audit('execution_committed', id, { planId, ...result, baselineCount });
                return { id, status: 'committed', inserted: rerun.accepted, additionalInserts: rerun.accepted, baselineCount, targetCount };
            }).immediate();
    }
    async reconcile(executionId: string): Promise<{
        baselineCount: number;
        source: number;
        accepted: number;
        rejected: number;
        ownedCount: number;
        targetCount: number;
        acceptedSpend: number;
        targetSpend: number;
        matched: boolean;
    }> {
        const execution = await this.db.prepare('SELECT * FROM executions WHERE id = ?').get(executionId) as ExecutionRow | undefined;
        if (!execution)
            throw new Error('Execution not found');
        const approval = await this.db.prepare('SELECT * FROM approvals WHERE plan_id = ?').get(execution.plan_id) as ApprovalRow | undefined;
        if (!approval) throw new Error('Execution approval not found');
        const run = await this.getDryRun(approval.dry_run_id);
        const ownedRows = (await this.targetRows()).filter((row) => row.execution_id === executionId);
        const owned = { count: ownedRows.length, spend: ownedRows.reduce((sum, row) => sum + (typeof row.spend_minor === 'number' ? row.spend_minor : 0), 0) };
        const targetCount = await this.targetCount();
        const acceptedSpend = run.result.rows.filter((row) => row.accepted)
            .reduce((sum, row) => sum + (typeof row.transformed.spend_minor === 'number' ? row.transformed.spend_minor : 0), 0);
        const matched = execution.status === 'committed'
            ? owned.count === run.result.accepted && owned.spend === acceptedSpend && targetCount === execution.baseline_count + owned.count
            : owned.count === 0 && targetCount === execution.baseline_count;
        return { baselineCount: execution.baseline_count, source: run.result.source, accepted: run.result.accepted, rejected: run.result.rejected, ownedCount: owned.count, targetCount, acceptedSpend, targetSpend: owned.spend, matched };
    }
    async rollback(executionId: string): Promise<{
        id: string;
        status: string;
        deleted: number;
        targetCount: number;
    }> {
        return await this.db.transaction(async () => {
            const execution = await this.db.prepare('SELECT * FROM executions WHERE id = ?').get(executionId) as ExecutionRow | undefined;
            if (!execution)
                throw new Error('Execution not found');
            if (execution.status === 'rolled_back') {
                await this.attempt(execution.plan_id, executionId, 'rollback', 'replayed', 'Already rolled back');
                await this.audit('rollback_retried', executionId, {});
                return { id: executionId, status: 'rolled_back', deleted: 0, targetCount: await this.targetCount() };
            }
            if (execution.status !== 'committed')
                throw new Error('Execution is not committed');
            if (!(await this.reconcile(executionId)).matched)
                throw new Error('Reconciliation mismatch blocks rollback');
            const deleted = (await this.db.prepare('DELETE FROM target_records WHERE execution_id = ?').run(executionId)).changes;
            await this.db.prepare("UPDATE executions SET status = 'rolled_back', updated_at = ? WHERE id = ?")
                .run(new Date().toISOString(), executionId);
            await this.attempt(execution.plan_id, executionId, 'rollback', 'committed', `Deleted ${deleted}`);
            await this.audit('execution_rolled_back', executionId, { deleted });
            return { id: executionId, status: 'rolled_back', deleted, targetCount: await this.targetCount() };
        }).immediate();
    }
    async targetCount(): Promise<number> {
        return Number((await this.db.prepare('SELECT COUNT(*) AS count FROM target_records').get() as { count: string | number }).count);
    }
    async targetRows(): Promise<(TargetRecord & {
        execution_id: string;
    })[]> {
        return (await this.db.prepare('SELECT record_json, execution_id FROM target_records ORDER BY target_key').all() as {
            record_json: string;
            execution_id: string;
        }[])
            .map((row) => ({ ...JSON.parse(row.record_json) as TargetRecord, execution_id: row.execution_id }));
    }
    async retry(executionId: string): Promise<Awaited<ReturnType<PostgresStore['execute']>>> {
        const row = await this.db.prepare('SELECT plan_id FROM executions WHERE id = ?').get(executionId) as {
            plan_id: string;
        } | undefined;
        if (!row)
            throw new Error('Execution not found');
        return await this.execute(row.plan_id);
    }
    async history(): Promise<unknown[]> {
        return await this.db.prepare('SELECT action, entity_id, detail_json, created_at FROM audit_events ORDER BY created_at, sequence_no').all();
    }
    async latestState(): Promise<{
        datasetId: string | null;
        planId: string | null;
        dryRunId: string | null;
        approved: boolean;
        planNeedsRefresh: boolean;
        executionId: string | null;
        executionStatus: string | null;
        activeExecutionId: string | null;
        activeExecutionDatasetId: string | null;
    }> {
        const dataset = await this.db.prepare('SELECT id FROM datasets ORDER BY sequence_no DESC LIMIT 1').get() as {
            id: string;
        } | undefined;
        const plan = dataset ? await this.db.prepare('SELECT id FROM plans WHERE dataset_id = ? ORDER BY version DESC LIMIT 1').get(dataset.id) as {
            id: string;
        } | undefined : undefined;
        const run = plan ? await this.db.prepare('SELECT id FROM dry_runs WHERE plan_id = ? ORDER BY sequence_no DESC LIMIT 1').get(plan.id) as {
            id: string;
        } | undefined : undefined;
        const approval = plan ? await this.db.prepare('SELECT plan_id FROM approvals WHERE plan_id = ?').get(plan.id) : undefined;
        const execution = plan ? await this.db.prepare('SELECT id, status FROM executions WHERE plan_id = ?').get(plan.id) as {
            id: string;
            status: string;
        } | undefined : undefined;
        const planNeedsRefresh = Boolean(run && !execution && (await this.getDryRun(run.id)).targetHash !== await this.targetHash());
        const active = await this.db.prepare("SELECT e.id, p.dataset_id FROM executions e JOIN plans p ON p.id = e.plan_id WHERE e.status = 'committed' LIMIT 1")
            .get() as {
            id: string;
            dataset_id: string;
        } | undefined;
        return { datasetId: dataset?.id ?? null, planId: plan?.id ?? null, dryRunId: run?.id ?? null, approved: Boolean(approval) && !planNeedsRefresh, planNeedsRefresh, executionId: execution?.id ?? null, executionStatus: execution?.status ?? null, activeExecutionId: active?.id ?? null, activeExecutionDatasetId: active?.dataset_id ?? null };
    }
}
