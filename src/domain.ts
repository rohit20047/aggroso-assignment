import { z } from 'zod';

export const MAX_SAMPLE_ROWS = 1000;
export const MAX_UPLOAD_BYTES = 1024 * 1024;
export const ruleNames = ['identity', 'trim', 'trim_join', 'trim_lower', 'trim_upper', 'enum_status', 'iso_utc', 'decimal_minor'] as const;
export type RuleName = typeof ruleNames[number];
export const ruleCatalog: { name: RuleName; effect: string; sources: number; output: 'same' | 'string' | 'integer' }[] = [
  { name: 'identity', effect: 'Copy without changing the value or type', sources: 1, output: 'same' },
  { name: 'trim', effect: 'Trim outer whitespace', sources: 1, output: 'string' },
  { name: 'trim_join', effect: 'Trim and join two text values', sources: 2, output: 'string' },
  { name: 'trim_lower', effect: 'Trim and lowercase text', sources: 1, output: 'string' },
  { name: 'trim_upper', effect: 'Trim and uppercase text', sources: 1, output: 'string' },
  { name: 'enum_status', effect: 'Map A to active and I to inactive', sources: 1, output: 'string' },
  { name: 'iso_utc', effect: 'Normalize a timezone-aware ISO timestamp to UTC', sources: 1, output: 'string' },
  { name: 'decimal_minor', effect: 'Convert a nonnegative decimal with at most two fractional digits to integer minor units exactly; reject extra digits or malformed values, never round', sources: 1, output: 'integer' },
];

const fieldName = z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/);
export const schemaFieldSchema = z.object({
  field: fieldName,
  type: z.enum(['string', 'integer', 'number', 'boolean']),
  required: z.boolean(),
  unique: z.boolean().optional(),
  maxLength: z.number().int().min(1).max(10000).optional(),
  format: z.enum(['email', 'iso_datetime', 'country_code']).optional(),
  enum: z.array(z.string()).min(1).max(30).optional(),
}).strict();
export type SchemaField = z.infer<typeof schemaFieldSchema>;
export const migrationInputSchema = z.object({
  sourceSchema: z.array(schemaFieldSchema).min(1).max(16),
  targetSchema: z.array(schemaFieldSchema).min(1).max(16),
  records: z.array(z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))).min(1).max(MAX_SAMPLE_ROWS),
  allowedRules: z.array(z.enum(ruleNames)).min(1).max(ruleNames.length),
}).strict();
export type MigrationInput = z.infer<typeof migrationInputSchema>;
export type SourceRecord = MigrationInput['records'][number];
export type TargetRecord = Record<string, string | number | boolean | null>;

export const sampleSourceSchema: SchemaField[] = [
  'customer_key', 'given_name', 'family_name', 'email_address', 'state', 'created_at', 'lifetime_spend', 'country',
].map((field) => ({ field, type: 'string', required: true }));
export const sampleTargetSchema: SchemaField[] = [
  { field: 'customer_id', type: 'string', required: true, unique: true, maxLength: 64 },
  { field: 'full_name', type: 'string', required: true, maxLength: 120 },
  { field: 'email', type: 'string', required: true, maxLength: 254, format: 'email' },
  { field: 'status', type: 'string', required: true, enum: ['active', 'inactive'] },
  { field: 'created_at_utc', type: 'string', required: true, format: 'iso_datetime' },
  { field: 'spend_minor', type: 'integer', required: true },
  { field: 'country_code', type: 'string', required: true, format: 'country_code' },
];
export const sampleAllowedRules: RuleName[] = ['trim', 'trim_join', 'trim_lower', 'enum_status', 'iso_utc', 'decimal_minor', 'trim_upper'];

export function validateInput(input: unknown): MigrationInput {
  const spec = migrationInputSchema.parse(input);
  for (const [side, schema] of [['source', spec.sourceSchema], ['target', spec.targetSchema]] as const) {
    if (new Set(schema.map((item) => item.field)).size !== schema.length) throw new Error(`Duplicate ${side} field`);
    for (const item of schema) {
      if ((item.maxLength !== undefined || item.format || item.enum) && item.type !== 'string') throw new Error(`Text constraint on non-text field: ${item.field}`);
    }
  }
  const unique = spec.targetSchema.filter((item) => item.unique);
  if (unique.length !== 1 || !unique[0]?.required || !['string', 'integer'].includes(unique[0].type)) throw new Error('Target requires exactly one required unique string or integer field');
  if (new Set(spec.allowedRules).size !== spec.allowedRules.length) throw new Error('Duplicate transformation rule');
  const source = new Set(spec.sourceSchema.map((item) => item.field));
  spec.records.forEach((record, index) => {
    for (const field of Object.keys(record)) if (!source.has(field)) throw new Error(`Unknown source field ${field} in row ${index + 1}`);
  });
  if (Buffer.byteLength(JSON.stringify(spec)) > MAX_UPLOAD_BYTES) throw new Error('Migration input exceeds 1 MiB');
  return spec;
}

export const mappingSchema = z.object({ target: fieldName, sources: z.array(fieldName).min(1).max(2), rule: z.enum(ruleNames) }).strict();
export const planSchema = z.object({ mappings: z.array(mappingSchema).min(1).max(16) }).strict();
export type Plan = z.infer<typeof planSchema>;

export function validatePlan(input: unknown, spec?: MigrationInput): Plan {
  const selected = spec ?? validateInput({ sourceSchema: sampleSourceSchema, targetSchema: sampleTargetSchema, records: [{}], allowedRules: sampleAllowedRules });
  const plan = planSchema.parse(input);
  const sources = new Map(selected.sourceSchema.map((field) => [field.field, field]));
  const targets = new Map(selected.targetSchema.map((field) => [field.field, field]));
  const seen = new Set<string>();
  for (const mapping of plan.mappings) {
    const target = targets.get(mapping.target);
    if (!target) throw new Error(`Unknown target field: ${mapping.target}`);
    if (seen.has(mapping.target)) throw new Error(`Duplicate target mapping: ${mapping.target}`);
    seen.add(mapping.target);
    if (!selected.allowedRules.includes(mapping.rule)) throw new Error(`Unsupported rule for ${mapping.target}: ${mapping.rule}`);
    const rule = ruleCatalog.find((item) => item.name === mapping.rule)!;
    if (mapping.sources.length !== rule.sources) throw new Error(`Wrong source count for ${mapping.target}`);
    const sourceFields = mapping.sources.map((field) => {
      const found = sources.get(field);
      if (!found) throw new Error(`Unknown source field: ${field}`);
      return found;
    });
    if (rule.output === 'same' && sourceFields[0]?.type !== target.type) throw new Error(`Incompatible identity types for ${mapping.target}`);
    if (rule.output === 'integer' && target.type !== 'integer') throw new Error(`Rule ${mapping.rule} requires an integer target`);
    if (rule.output === 'string' && target.type !== 'string') throw new Error(`Rule ${mapping.rule} requires a text target`);
    if (mapping.rule !== 'identity' && sourceFields.some((field) => field.type !== 'string')) throw new Error(`Rule ${mapping.rule} requires text sources`);
  }
  if (seen.size !== targets.size) throw new Error('Every target field must be mapped');
  return plan;
}

export interface FieldError { field: string; rule: string; code: string; message: string; original: unknown }
export interface RowResult { row: number; original: SourceRecord; transformed: TargetRecord; accepted: boolean; errors: FieldError[] }
export interface DryRunResult { source: number; transformed: number; accepted: number; rejected: number; rows: RowResult[] }

function applyRule(rule: RuleName, values: (string | number | boolean | null | undefined)[]): string | number | boolean | null {
  const raw = values[0];
  if (rule === 'identity') return raw ?? null;
  const value = typeof raw === 'string' ? raw : '';
  switch (rule) {
    case 'trim': return value.trim();
    case 'trim_join': return values.map((part) => typeof part === 'string' ? part.trim() : '').filter(Boolean).join(' ');
    case 'trim_lower': return value.trim().toLowerCase();
    case 'trim_upper': return value.trim().toUpperCase();
    case 'enum_status': {
      const state = value.trim().toUpperCase();
      if (state === 'A') return 'active';
      if (state === 'I') return 'inactive';
      throw new Error('Unknown status code');
    }
    case 'iso_utc': {
      const input = value.trim();
      if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(input)) throw new Error('Timestamp must include a timezone');
      const date = new Date(input);
      if (Number.isNaN(date.getTime())) throw new Error('Invalid timestamp');
      const localDate = input.slice(0, 10);
      if (!new Date(`${localDate}T00:00:00Z`).toISOString().startsWith(localDate)) throw new Error('Invalid calendar date');
      return date.toISOString();
    }
    case 'decimal_minor': {
      const match = /^(0|[1-9]\d*)(?:\.(\d{1,2}))?$/.exec(value.trim());
      if (!match) throw new Error('Expected a nonnegative amount with at most two decimal places');
      const amount = BigInt(match[1] ?? '0') * 100n + BigInt((match[2] ?? '').padEnd(2, '0'));
      if (amount > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Amount is too large');
      return Number(amount);
    }
  }
}

function invalid(field: SchemaField, value: unknown): string | null {
  if (value === null || value === undefined || value === '') return field.required ? 'A value is required' : null;
  if (field.type === 'string' && typeof value !== 'string') return 'Expected text';
  if (field.type === 'integer' && (typeof value !== 'number' || !Number.isSafeInteger(value))) return 'Expected a safe integer';
  if (field.type === 'number' && (typeof value !== 'number' || !Number.isFinite(value))) return 'Expected a finite number';
  if (field.type === 'boolean' && typeof value !== 'boolean') return 'Expected true or false';
  if (typeof value === 'string') {
    if (field.maxLength && value.length > field.maxLength) return `Must be at most ${field.maxLength} characters`;
    if (field.enum && !field.enum.includes(value)) return `Must be one of: ${field.enum.join(', ')}`;
    if (field.format === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return 'Expected a valid email';
    if (field.format === 'country_code' && !/^[A-Z]{2}$/.test(value)) return 'Expected two uppercase letters';
    if (field.format === 'iso_datetime' && (Number.isNaN(Date.parse(value)) || !/^\d{4}-\d{2}-\d{2}T/.test(value))) return 'Expected an ISO timestamp';
  }
  return null;
}

export function dryRun(recordsInput: unknown, planInput: unknown, occupiedIds: ReadonlySet<string> = new Set(), spec?: MigrationInput): DryRunResult {
  const selected = spec ? validateInput(spec) : validateInput({ sourceSchema: sampleSourceSchema, targetSchema: sampleTargetSchema, records: recordsInput, allowedRules: sampleAllowedRules });
  const plan = validatePlan(planInput, selected);
  const uniqueField = selected.targetSchema.find((field) => field.unique)!.field;
  const rows = selected.records.map((original, index) => {
    const transformed: TargetRecord = {};
    const errors: FieldError[] = [];
    for (const field of selected.sourceSchema) {
      const failure = invalid(field, original[field.field]);
      if (failure) errors.push({ field: field.field, rule: 'source_validation', code: 'INVALID_SOURCE', message: failure, original: original[field.field] ?? null });
    }
    for (const mapping of plan.mappings) {
      const values = mapping.sources.map((source) => original[source]);
      try { transformed[mapping.target] = applyRule(mapping.rule, values); }
      catch (error) { errors.push({ field: mapping.target, rule: mapping.rule, code: 'TRANSFORM_FAILED', message: error instanceof Error ? error.message : 'Transformation failed', original: values }); }
    }
    const transformedSuccessfully = errors.every((error) => error.code !== 'TRANSFORM_FAILED');
    for (const field of selected.targetSchema) {
      if (errors.some((error) => error.field === field.field && error.code === 'TRANSFORM_FAILED')) continue;
      const failure = invalid(field, transformed[field.field]);
      if (failure) errors.push({ field: field.field, rule: 'target_validation', code: 'INVALID_TARGET', message: failure, original: transformed[field.field] ?? null });
    }
    return { row: index + 1, original, transformed, accepted: false, errors, transformedSuccessfully };
  });
  const ids = new Map<string, number[]>();
  for (const row of rows) {
    const value = row.transformed[uniqueField];
    if (value === null || value === undefined || value === '') continue;
    const id = String(value);
    ids.set(id, [...(ids.get(id) ?? []), row.row]);
  }
  for (const row of rows) {
    const value = row.transformed[uniqueField];
    const id = value === null || value === undefined ? '' : String(value);
    if (id && (ids.get(id)?.length ?? 0) > 1) row.errors.push({ field: uniqueField, rule: 'source_uniqueness', code: 'DUPLICATE_SOURCE_ID', message: `Duplicate key in rows ${ids.get(id)?.join(', ')}`, original: value });
    if (id && occupiedIds.has(id)) row.errors.push({ field: uniqueField, rule: 'target_uniqueness', code: 'TARGET_CONFLICT', message: 'Key already exists in the target', original: value });
    row.accepted = row.errors.length === 0;
  }
  const transformed = rows.filter((row) => row.transformedSuccessfully).length;
  const accepted = rows.filter((row) => row.accepted).length;
  return { source: rows.length, transformed, accepted, rejected: rows.length - accepted, rows: rows.map(({ transformedSuccessfully: _discard, ...row }) => row) };
}
