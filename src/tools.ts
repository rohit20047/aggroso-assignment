import { dryRun, ruleCatalog, validatePlan } from './domain.js';
import type { MigrationRepository } from './repository.js';
export const inspectionTools = [
    'get_schemas', 'profile_source', 'list_transformations', 'validate_mapping', 'preview_mapping',
] as const;
export type InspectionTool = typeof inspectionTools[number];
export class InspectionDispatcher {
    private callCount = 0;
    constructor(private readonly store: MigrationRepository, private readonly datasetId: string, private readonly maxCalls = 8) { }
    async invoke(name: string, input: unknown = {}): Promise<unknown> {
        if (!inspectionTools.includes(name as InspectionTool))
            throw new Error('Tool is not allowed');
        if (++this.callCount > this.maxCalls)
            throw new Error('Inspection tool limit reached');
        const dataset = await this.store.getDataset(this.datasetId);
        const args = typeof input === 'object' && input !== null ? input as Record<string, unknown> : {};
        switch (name as InspectionTool) {
            case 'get_schemas':
                return {
                    source: dataset.input.sourceSchema,
                    target: dataset.input.targetSchema,
                    datasetHash: dataset.hash,
                };
            case 'profile_source': {
                const fields = dataset.input.sourceSchema.map((field) => field.field);
                const profile = fields.map((field) => {
                    const values = dataset.records.map((record) => record[field]);
                    return { field, blankCount: values.filter((value) => value === null || value === undefined || value === '').length, distinctCount: new Set(values).size };
                });
                return { rowCount: dataset.records.length, fields: profile };
            }
            case 'list_transformations':
                return { version: 'bounded-rules-v2', transformations: ruleCatalog.filter((rule) => dataset.input.allowedRules.includes(rule.name)) };
            case 'validate_mapping': {
                try {
                    validatePlan(args.plan, dataset.input);
                    return { valid: true, errors: [] };
                }
                catch (error) {
                    return { valid: false, errors: [error instanceof Error ? error.message : 'Invalid mapping'] };
                }
            }
            case 'preview_mapping': {
                const plan = validatePlan(args.plan, dataset.input);
                const key = dataset.input.targetSchema.find((field) => field.unique)!.field;
                const result = dryRun(dataset.records, plan, new Set(await (await this.store.targetRows()).map((row) => String(row[key]))), dataset.input);
                return {
                    source: result.source,
                    transformed: result.transformed,
                    accepted: result.accepted,
                    rejected: result.rejected,
                    examples: result.rows.slice(0, 5).map((row) => ({ row: row.row, transformed: row.transformed, errors: row.errors.map(({ field, code, message }) => ({ field, code, message })) })),
                };
            }
        }
    }
}
