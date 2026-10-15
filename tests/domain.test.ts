import { describe, expect, it } from 'vitest';
import { dryRun, validatePlan } from '../src/domain.js';
import { samplePlan, sampleRecords } from '../src/sample.js';

describe('deterministic migration engine', () => {
  it('quarantines invalid sample rows with field-level evidence', () => {
    const result = dryRun(sampleRecords, samplePlan);
    expect(result.source).toBe(20);
    expect(result.transformed).toBe(18);
    expect(result.accepted).toBe(14);
    expect(result.rejected).toBe(6);
    expect(result.rows[18]?.errors[0]?.code).toBe('DUPLICATE_SOURCE_ID');
    expect(result.rows[19]?.errors[0]?.code).toBe('DUPLICATE_SOURCE_ID');
    expect(result.rows[16]?.errors.some((error) => error.field === 'status')).toBe(true);
  });

  it('produces identical results for identical inputs', () => {
    expect(dryRun(sampleRecords, samplePlan)).toEqual(dryRun(sampleRecords, samplePlan));
  });

  it('rejects unsupported mappings', () => {
    const changed = structuredClone(samplePlan);
    changed.mappings[0]!.rule = 'identity';
    expect(() => validatePlan(changed)).toThrow('Unsupported rule');
  });

  it('detects existing target IDs', () => {
    const result = dryRun(sampleRecords, samplePlan, new Set(['CUST-001']));
    expect(result.accepted).toBe(13);
    expect(result.rows[0]?.errors.some((error) => error.code === 'TARGET_CONFLICT')).toBe(true);
  });

  it('rejects a calendar date that JavaScript would otherwise normalize', () => {
    const records = structuredClone(sampleRecords);
    records[0]!.created_at = '2024-02-30T10:00:00Z';
    const result = dryRun(records, samplePlan);
    expect(result.rows[0]?.errors.some((error) => error.field === 'created_at_utc')).toBe(true);
  });
});
