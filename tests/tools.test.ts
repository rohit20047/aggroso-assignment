import { describe, expect, it } from 'vitest';
import { InspectionDispatcher } from '../src/tools.js';
import { MigrationStore } from '../src/store.js';
import { samplePlan, sampleRecords } from '../src/sample.js';

describe('AI inspection boundary', () => {
  it('allows bounded read-only inspection and rejects unknown tools', async () => {
    const store = new MigrationStore(':memory:');
    try {
      const dataset = store.createDataset(sampleRecords);
      const tools = new InspectionDispatcher(store, dataset.id, 2);
      expect(await tools.invoke('get_schemas')).toHaveProperty('source');
      expect(await tools.invoke('validate_mapping', { plan: samplePlan })).toMatchObject({ valid: true });
      await expect(tools.invoke('execute')).rejects.toThrow('not allowed');
      await expect(tools.invoke('profile_source')).rejects.toThrow('limit');
      expect(store.targetCount()).toBe(0);
    } finally {
      store.close();
    }
  });
});
