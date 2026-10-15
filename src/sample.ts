import { sampleAllowedRules, sampleSourceSchema, sampleTargetSchema, type MigrationInput, type Plan, type SourceRecord } from './domain.js';

export const samplePlan: Plan = {
  mappings: [
    { target: 'customer_id', sources: ['customer_key'], rule: 'trim' },
    { target: 'full_name', sources: ['given_name', 'family_name'], rule: 'trim_join' },
    { target: 'email', sources: ['email_address'], rule: 'trim_lower' },
    { target: 'status', sources: ['state'], rule: 'enum_status' },
    { target: 'created_at_utc', sources: ['created_at'], rule: 'iso_utc' },
    { target: 'spend_minor', sources: ['lifetime_spend'], rule: 'decimal_minor' },
    { target: 'country_code', sources: ['country'], rule: 'trim_upper' },
  ],
};

export const sampleRecords: SourceRecord[] = Array.from({ length: 20 }, (_, index) => {
  const number = index + 1;
  return {
    customer_key: `CUST-${String(number).padStart(3, '0')}`,
    given_name: `Customer${number}`,
    family_name: 'Example',
    email_address: `customer${number}@example.test`,
    state: number % 2 === 0 ? 'I' : 'A',
    created_at: '2024-01-01T10:00:00Z',
    lifetime_spend: '12.34',
    country: 'US',
  };
});

sampleRecords[14] = { ...sampleRecords[14]!, given_name: '', family_name: '' };
sampleRecords[15] = { ...sampleRecords[15]!, email_address: 'bad-email' };
sampleRecords[16] = { ...sampleRecords[16]!, state: 'X' };
sampleRecords[17] = { ...sampleRecords[17]!, lifetime_spend: '1.234' };
sampleRecords[19] = { ...sampleRecords[19]!, customer_key: String(sampleRecords[18]!.customer_key) };

export const sampleInput: MigrationInput = {
  sourceSchema: sampleSourceSchema,
  targetSchema: sampleTargetSchema,
  records: sampleRecords,
  allowedRules: sampleAllowedRules,
};
