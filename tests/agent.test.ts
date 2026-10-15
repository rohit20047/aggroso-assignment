import { describe, expect, it } from 'vitest';
import { AgentPlanner, type ChatClient } from '../src/agent.js';
import { MigrationStore } from '../src/store.js';
import { samplePlan, sampleRecords } from '../src/sample.js';

describe('AI proposal boundary', () => {
  it('plans from user-supplied schemas and only the selected rule catalog', async () => {
    const store = new MigrationStore(':memory:');
    try {
      const dataset = store.createDataset({
        sourceSchema: [{ field: 'legacy_code', type: 'string', required: true }],
        targetSchema: [{ field: 'account_code', type: 'string', required: true, unique: true }],
        records: [{ legacy_code: ' A1 ' }],
        allowedRules: ['trim'],
      });
      const plan = { mappings: [{ target: 'account_code', sources: ['legacy_code'], rule: 'trim' }] };
      const client: ChatClient = { async complete(messages) {
        const prompt = messages.find((message) => message.role === 'user')?.content ?? '';
        expect(prompt).toContain('legacy_code');
        expect(prompt).toContain('account_code');
        expect(prompt).toContain('trim');
        expect(prompt).not.toContain('trim_join');
        return { model: 'fake-test-model', message: { content: JSON.stringify({ plan, summary: 'Account code migration', rationales: [{ target: 'account_code', reason: 'Corresponding identifier', evidence: 'legacy_code' }], risks: [], assumptions: [], questions: [] }) } };
      } };
      const result = await new AgentPlanner(store, client).propose(dataset.id);
      expect(store.getPlan(result.planId).plan).toEqual(plan);
      expect(store.createDryRun(result.planId).result.accepted).toBe(1);
    } finally { store.close(); }
  });

  it('saves a validated draft after inspection without executing', async () => {
    const store = new MigrationStore(':memory:');
    try {
      const dataset = store.createDataset(sampleRecords);
      const client: ChatClient = {
        async complete(_messages, tools) {
          expect(tools).toEqual([]);
          return { model: 'fake-test-model', message: { content: JSON.stringify({ plan: samplePlan, summary: 'Proposed customer mapping', rationales: samplePlan.mappings.map(({ target, sources }) => ({ target, reason: 'Supported mapping', evidence: sources.join(', ') })), risks: [], assumptions: [], questions: [] }) } };
        },
      };
      const result = await new AgentPlanner(store, client).propose(dataset.id);
      expect(result.toolCalls).toEqual(['get_schemas', 'profile_source', 'list_transformations', 'validate_mapping', 'preview_mapping']);
      expect(store.getPlan(result.planId).version).toBe(1);
      expect(store.targetCount()).toBe(0);
    } finally {
      store.close();
    }
  });

  it('revises a previous plan through AI and creates a new version without a target write', async () => {
    const store = new MigrationStore(':memory:');
    try {
      const dataset = store.createDataset(sampleRecords);
      const first = store.createPlan(dataset.id, samplePlan);
      let inspectedPrompt = false;
      const client: ChatClient = {
        async complete(messages) {
          inspectedPrompt = messages.some((message) => message.role === 'user' && message.content.includes('Revise this existing plan') && message.content.includes('reconsider status'));
          return { model: 'fake-test-model', message: { content: JSON.stringify({ plan: samplePlan, summary: 'Revised customer mapping', rationales: samplePlan.mappings.map(({ target, sources }) => ({ target, reason: 'Checked mapping', evidence: sources.join(', ') })), risks: [], assumptions: [], questions: [] }) } };
        },
      };
      const result = await new AgentPlanner(store, client).propose(dataset.id, 'reconsider status', first.id);
      expect(inspectedPrompt).toBe(true);
      expect(result.planVersion).toBe(2);
      expect(store.getPlan(first.id).version).toBe(1);
      expect(store.targetCount()).toBe(0);
    } finally {
      store.close();
    }
  });

  it('accepts a fenced Gemini revision and carries explanations only for unchanged mappings', async () => {
    const store = new MigrationStore(':memory:');
    try {
      const dataset = store.createDataset({
        sourceSchema: [{ field: 'old_id', type: 'string', required: true }, { field: 'old_email', type: 'string', required: true }, { field: 'new_email', type: 'string', required: true }],
        targetSchema: [{ field: 'id', type: 'string', required: true, unique: true }, { field: 'email', type: 'string', required: true, format: 'email' }],
        records: [{ old_id: ' A1 ', old_email: 'bad-email', new_email: 'A1@EXAMPLE.TEST' }],
        allowedRules: ['trim', 'trim_lower'],
      });
      const initialPlan = { mappings: [{ target: 'id', sources: ['old_id'], rule: 'trim' }, { target: 'email', sources: ['old_email'], rule: 'trim_lower' }] };
      const initial = store.createPlan(dataset.id, initialPlan);
      store.recordProposal(initial.id, {
        plan: initialPlan,
        summary: 'Initial mapping',
        rationales: [{ target: 'id', reason: 'Identifier', evidence: 'old_id' }, { target: 'email', reason: 'Original email', evidence: 'old_email' }],
        risks: [], assumptions: [], questions: [],
      }, 'fake-test-model', []);
      const revisedPlan = { mappings: [initialPlan.mappings[0], { target: 'email', sources: ['new_email'], rule: 'trim_lower' }] };
      const partial = { plan: revisedPlan, summary: 'Use the alternate email', rationales: [{ target: 'email', reason: 'Reviewer requested this field', evidence: 'new_email' }], risks: [], assumptions: [{ assumption: 'The alternate address is approved' }], questions: [] };
      const client: ChatClient = { async complete() { return { model: 'gemini-test', message: { content: `\`\`\`json\n${JSON.stringify(partial)}\n\`\`\`` } }; } };
      const result = await new AgentPlanner(store, client).propose(dataset.id, 'Use the new email', initial.id);
      expect(result.planVersion).toBe(2);
      expect(result.proposal.assumptions).toEqual(['The alternate address is approved']);
      expect(result.proposal.rationales).toEqual([
        { target: 'id', reason: 'Identifier', evidence: 'old_id' },
        { target: 'email', reason: 'Reviewer requested this field', evidence: 'new_email' },
      ]);
      expect(store.createDryRun(result.planId).result.accepted).toBe(1);
    } finally { store.close(); }
  });

  it('normalizes a target-keyed AI plan and still validates its rules', async () => {
    const store = new MigrationStore(':memory:');
    try {
      const dataset = store.createDataset(sampleRecords);
      const keyedPlan = Object.fromEntries(samplePlan.mappings.map(({ target, sources, rule }) => [target, { sources, rule }]));
      const client: ChatClient = {
        async complete() {
          return { model: 'fake-test-model', message: { content: JSON.stringify({ plan: keyedPlan, summary: 'Customer mapping', rationales: samplePlan.mappings.map(({ target, sources }) => ({ target, reason: 'Mapped', evidence: sources.join(', ') })), risks: [], assumptions: [], questions: [] }) } };
        },
      };
      const result = await new AgentPlanner(store, client).propose(dataset.id);
      expect(store.getPlan(result.planId).plan).toEqual(samplePlan);
    } finally {
      store.close();
    }
  });

  it('accepts a complete AI mapping array under plan', async () => {
    const store = new MigrationStore(':memory:');
    try {
      const dataset = store.createDataset(sampleRecords);
      const client: ChatClient = {
        async complete() {
          return { model: 'fake-test-model', message: { content: JSON.stringify({ plan: samplePlan.mappings, summary: 'Customer mapping', rationales: samplePlan.mappings.map(({ target, sources }) => ({ target, reason: 'Mapped', evidence: sources.join(', ') })), risks: [], assumptions: [], questions: [] }) } };
        },
      };
      const result = await new AgentPlanner(store, client).propose(dataset.id);
      expect(store.getPlan(result.planId).plan).toEqual(samplePlan);
    } finally {
      store.close();
    }
  });

  it('rejects model requests for unapproved tools', async () => {
    const store = new MigrationStore(':memory:');
    try {
      const dataset = store.createDataset(sampleRecords);
      const client: ChatClient = {
        async complete() {
          return { model: 'fake-test-model', message: { content: null, tool_calls: [{ id: 'call-one', type: 'function' as const, function: { name: 'execute', arguments: '{}' } }] } };
        },
      };
      await expect(new AgentPlanner(store, client).propose(dataset.id)).rejects.toThrow('not allowed');
      expect(store.targetCount()).toBe(0);
    } finally {
      store.close();
    }
  });

  it('allows one correction of an invalid proposal before saving', async () => {
    const store = new MigrationStore(':memory:');
    try {
      const dataset = store.createDataset(sampleRecords);
      let calls = 0;
      const valid = { plan: samplePlan, summary: 'Reviewed mapping', rationales: samplePlan.mappings.map(({ target, sources }) => ({ target, reason: 'Mapped source data', evidence: sources.join(', ') })), risks: [], assumptions: [], questions: [] };
      const client: ChatClient = {
        async complete(messages) {
          calls++;
          if (calls === 1) return { model: 'fake-test-model', message: { content: JSON.stringify({ ...valid, plan: { mappings: valid.plan.mappings.map((mapping, index) => index === 3 ? { ...mapping, sources: [] } : mapping) } }) } };
          expect(messages.at(-1)?.content).toContain('sources');
          return { model: 'fake-test-model', message: { content: JSON.stringify(valid) } };
        },
      };
      const result = await new AgentPlanner(store, client).propose(dataset.id);
      expect(calls).toBe(2);
      expect(store.getPlan(result.planId).version).toBe(1);
      expect(store.targetCount()).toBe(0);
    } finally {
      store.close();
    }
  });
});
