import Fastify from 'fastify';
import { z, ZodError } from 'zod';
import { AgentPlanner } from './agent.js';
import { MAX_UPLOAD_BYTES, ruleCatalog, sampleAllowedRules, sampleSourceSchema, sampleTargetSchema } from './domain.js';
import type { MigrationRepository } from './repository.js';
import { sampleInput, samplePlan } from './sample.js';
import { InspectionDispatcher } from './tools.js';
const idParams = z.object({ id: z.string().uuid() });
const recordsBody = z.object({ records: z.unknown(), sourceSchema: z.unknown().optional(), targetSchema: z.unknown().optional(), allowedRules: z.unknown().optional() });
const planBody = z.object({ plan: z.unknown() });
const approvalBody = z.object({
    dryRunId: z.string().uuid(),
    digest: z.string().regex(/^[a-f0-9]{64}$/),
    actor: z.string().min(1).max(100),
    acknowledgeRejected: z.boolean(),
    answers: z.record(z.string(), z.string().max(1000)).optional(),
});
export function buildApp(store: MigrationRepository, agent?: AgentPlanner) {
    const app = Fastify({ logger: true, bodyLimit: MAX_UPLOAD_BYTES + 8192 });
    app.setErrorHandler((error, request, reply) => {
        if (error instanceof ZodError) {
            const first = error.issues[0];
            const location = first?.path.join('.') || 'input';
            reply.code(400).send({ code: 'VALIDATION_ERROR', message: `Invalid ${location}: ${first?.message ?? 'check the submitted values'}`, details: error.issues, requestId: request.id });
            return;
        }
        const message = error instanceof Error ? error.message : 'Unexpected error';
        if (/gemini|model |planning step|tool arguments|tool limit/i.test(message)) {
            request.log.warn({ err: error }, 'AI planning failed');
            reply.code(503).send({ code: 'AI_UNAVAILABLE', message: 'AI planning failed; saved work is unchanged', requestId: request.id });
            return;
        }
        const expected = error instanceof Error && /not found|must be approved|stale|changed|acknowledged|newer|unsupported|duplicate|rollback|rolled-back|conflict|exceeds|requires|blocking question|already has an approval|unknown|target|source|field|schema|rule|input/.test(message.toLowerCase());
        const status = message.includes('not found') ? 404 : expected ? 409 : 500;
        if (status === 500)
            request.log.error({ err: error }, 'Request failed');
        reply.code(status).send({ code: status === 500 ? 'INTERNAL_ERROR' : 'WORKFLOW_ERROR', message: status === 500 ? 'Unexpected server error' : message, requestId: request.id });
    });
    app.get('/health', async () => ({ status: 'ok' }));
    app.post('/api/datasets', async (request) => {
        const body = recordsBody.parse(request.body);
        return await store.createDataset({
            records: body.records,
            sourceSchema: body.sourceSchema ?? sampleSourceSchema,
            targetSchema: body.targetSchema ?? sampleTargetSchema,
            allowedRules: body.allowedRules ?? sampleAllowedRules,
        });
    });
    app.get('/api/sample', async () => ({ ...sampleInput, plan: samplePlan }));
    app.get('/api/rules', async () => ({ rules: ruleCatalog }));
    app.get('/api/state', async () => await store.latestState());
    app.get('/api/datasets/:id', async (request) => {
        const { id } = idParams.parse(request.params);
        return await store.getDataset(id);
    });
    app.get('/api/datasets/:id/schemas', async (request) => {
        const { id } = idParams.parse(request.params);
        return new InspectionDispatcher(store, id).invoke('get_schemas');
    });
    app.post('/api/datasets/:id/plans', async (request) => {
        const { id } = idParams.parse(request.params);
        const body = planBody.parse(request.body);
        return await store.createPlan(id, body.plan);
    });
    app.get('/api/datasets/:id/plans', async (request) => {
        const { id } = idParams.parse(request.params);
        return { versions: await store.listPlans(id) };
    });
    app.post('/api/datasets/:id/proposals', async (request, reply) => {
        if (!agent) {
            reply.code(503);
            return { code: 'AI_NOT_CONFIGURED', message: 'GEMINI_API_KEY is required on the server' };
        }
        const { id } = idParams.parse(request.params);
        const { note, basePlanId } = z.object({ note: z.string().max(1000).optional(), basePlanId: z.string().uuid().optional() }).parse(request.body ?? {});
        await store.getDataset(id);
        try {
            const result = await agent.propose(id, note, basePlanId);
            return { ...result, dryRun: await store.createDryRun(result.planId) };
        }
        catch (error) {
            request.log.warn({ err: error }, 'AI proposal failed; no migration was executed');
            reply.code(503);
            const detail = error instanceof Error ? error.message : '';
            const message = /rate limited|quota/i.test(detail) ? 'The Gemini model is rate limited or its quota is exhausted. Try again later or select another model.'
                : /timeout|aborted/i.test(detail) ? 'The Gemini model timed out. Try again later or select another model.'
                    : /invalid or lacks access/i.test(detail) ? 'The Gemini API key is invalid or lacks access to this model.'
                        : 'AI planning failed; saved work is unchanged';
            return { code: 'AI_PROPOSAL_FAILED', message, requestId: request.id };
        }
    });
    app.get('/api/plans/:id', async (request) => {
        const { id } = idParams.parse(request.params);
        return await store.getPlan(id);
    });
    app.get('/api/plans/:id/proposal', async (request) => {
        const { id } = idParams.parse(request.params);
        return { proposal: await store.getProposal(id) };
    });
    app.post('/api/plans/:id/dry-runs', async (request) => {
        const { id } = idParams.parse(request.params);
        return await store.createDryRun(id);
    });
    app.get('/api/dry-runs/:id', async (request) => {
        const { id } = idParams.parse(request.params);
        return await store.getDryRun(id);
    });
    app.get('/api/plans/:id/approval-digest', async (request) => {
        const { id } = idParams.parse(request.params);
        const { dryRunId } = z.object({ dryRunId: z.string().uuid() }).parse(request.query);
        return { digest: await store.approvalDigest(id, dryRunId) };
    });
    app.post('/api/plans/:id/approve', async (request) => {
        const { id } = idParams.parse(request.params);
        const body = approvalBody.parse(request.body);
        await store.approve(id, body.dryRunId, body.digest, body.actor, body.acknowledgeRejected, body.answers);
        return { status: 'approved', planId: id };
    });
    app.post('/api/plans/:id/execute', async (request) => {
        const { id } = idParams.parse(request.params);
        return await store.execute(id);
    });
    app.post('/api/executions/:id/retry', async (request) => {
        const { id } = idParams.parse(request.params);
        return await store.retry(id);
    });
    app.get('/api/executions/:id/reconciliation', async (request) => {
        const { id } = idParams.parse(request.params);
        return await store.reconcile(id);
    });
    app.post('/api/executions/:id/rollback', async (request) => {
        const { id } = idParams.parse(request.params);
        return await store.rollback(id);
    });
    app.get('/api/target', async () => ({ rows: await store.targetRows() }));
    app.get('/api/history', async () => ({ events: await store.history() }));
    return app;
}
