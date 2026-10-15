import { useEffect, useState } from 'react';

type Mapping = { target: string; sources: string[]; rule: string };
type PlanData = { mappings: Mapping[] };
type SourceRecord = Record<string, string | number | boolean | null>;
type FieldError = { field: string; rule: string; code: string; message: string; original: unknown };
type RowResult = { row: number; original: SourceRecord; transformed: Record<string, unknown>; accepted: boolean; errors: FieldError[] };
type DryRunResult = { source: number; transformed: number; accepted: number; rejected: number; rows: RowResult[] };
type Proposal = {
  summary: string;
  rationales: { target: string; reason: string; evidence: string }[];
  risks: { severity: 'low' | 'medium' | 'high'; field: string; explanation: string }[];
  assumptions: string[];
  questions: { field: string; question: string; blocking: boolean }[];
};
type SavedPlan = { id: string; version: number; plan: PlanData };
type PlanVersion = { id: string; version: number; createdAt: string };
type Dataset = { id: string; count?: number; records?: SourceRecord[]; input?: MigrationInput; hash?: string };
type SchemaField = { field: string; type: string; required: boolean; unique?: boolean; maxLength?: number; format?: string; enum?: string[] };
type Schemas = { source: SchemaField[]; target: SchemaField[]; datasetHash: string };
type MigrationInput = { sourceSchema: SchemaField[]; targetSchema: SchemaField[]; records: SourceRecord[]; allowedRules: string[] };
type Rule = { name: string; effect: string; sources: number; output: string };
type DryRun = { id: string; result: DryRunResult };
type Execution = { id: string; status: string; inserted?: number; additionalInserts?: number; targetCount?: number };
type Reconciliation = { baselineCount: number; source: number; accepted: number; rejected: number; ownedCount: number; targetCount: number; acceptedSpend: number; targetSpend: number; matched: boolean };
type HistoryEvent = { action: string; entity_id: string; detail_json: string; created_at: string };
type WorkbenchState = { datasetId: string | null; planId: string | null; dryRunId: string | null; approved: boolean; planNeedsRefresh: boolean; executionId: string | null; executionStatus: string | null; activeExecutionId: string | null; activeExecutionDatasetId: string | null };

const steps = ['Inputs', 'Mapping plan', 'Dry run', 'Approval', 'Reconciliation'];
class ApiError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}
async function api<T>(path: string, secret: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method,
    headers: { ...(secret ? { 'x-reviewer-key': secret } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({})) as { message?: string };
  if (!response.ok) throw new ApiError(payload.message ?? `Request failed (${response.status})`, response.status);
  return payload as T;
}

function Metric({ label, value, tone }: { label: string; value: number | string; tone?: string }) {
  return <div className={`metric ${tone ?? ''}`}><span>{label}</span><strong>{value}</strong></div>;
}

export default function App() {
  const [secret, setSecret] = useState(() => sessionStorage.getItem('reviewerKey') ?? '');
  const [ready, setReady] = useState(() => sessionStorage.getItem('workbenchReady') === 'true');
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [dataset, setDataset] = useState<Dataset | null>(null);
  const [schemas, setSchemas] = useState<Schemas | null>(null);
  const [sourceSchemaText, setSourceSchemaText] = useState('');
  const [targetSchemaText, setTargetSchemaText] = useState('');
  const [sourceText, setSourceText] = useState('');
  const [selectedRules, setSelectedRules] = useState<string[]>([]);
  const [ruleCatalog, setRuleCatalog] = useState<Rule[]>([]);
  const [plan, setPlan] = useState<SavedPlan | null>(null);
  const [planVersions, setPlanVersions] = useState<PlanVersion[]>([]);
  const [inspectedVersion, setInspectedVersion] = useState<SavedPlan | null>(null);
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [revisionNote, setRevisionNote] = useState('');
  const [dryRun, setDryRun] = useState<DryRun | null>(null);
  const [approved, setApproved] = useState(false);
  const [planNeedsRefresh, setPlanNeedsRefresh] = useState(false);
  const [acknowledge, setAcknowledge] = useState(false);
  const [actor, setActor] = useState('Reviewer');
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [execution, setExecution] = useState<Execution | null>(null);
  const [reconciliation, setReconciliation] = useState<Reconciliation | null>(null);
  const [priorActive, setPriorActive] = useState<Execution | null>(null);
  const [priorReconciliation, setPriorReconciliation] = useState<Reconciliation | null>(null);
  const [priorTargetSchema, setPriorTargetSchema] = useState<SchemaField[]>([]);
  const [history, setHistory] = useState<HistoryEvent[]>([]);
  const [targetRows, setTargetRows] = useState<Record<string, unknown>[]>([]);

  useEffect(() => {
    if (!ready) return;
    let live = true;
    (async () => {
      try {
        const sample = await api<MigrationInput>('/api/sample', secret);
        if (!live) return;
        setSourceText(JSON.stringify(sample.records, null, 2));
        setSourceSchemaText(JSON.stringify(sample.sourceSchema, null, 2));
        setTargetSchemaText(JSON.stringify(sample.targetSchema, null, 2));
        setSelectedRules(sample.allowedRules);
        const catalog = await api<{ rules: Rule[] }>('/api/rules', secret);
        if (live) setRuleCatalog(catalog.rules);
        const current = await api<WorkbenchState>('/api/state', secret);
        if (!live) return;
        setStep(current.executionId ? 4 : current.approved ? 3 : current.dryRunId ? 2 : current.planId ? 1 : 0);
        if (current.datasetId) {
          const saved = await api<Dataset>(`/api/datasets/${current.datasetId}`, secret);
          const schemaDetails = await api<Schemas>(`/api/datasets/${current.datasetId}/schemas`, secret);
          const versions = await api<{ versions: PlanVersion[] }>(`/api/datasets/${current.datasetId}/plans`, secret);
          if (live) {
            setDataset({ ...saved, count: saved.records?.length }); setSchemas(schemaDetails); setPlanVersions(versions.versions);
            if (saved.input) {
              setSourceText(JSON.stringify(saved.input.records, null, 2));
              setSourceSchemaText(JSON.stringify(saved.input.sourceSchema, null, 2));
              setTargetSchemaText(JSON.stringify(saved.input.targetSchema, null, 2));
              setSelectedRules(saved.input.allowedRules);
            }
          }
        }
        if (current.planId) {
          const saved = await api<SavedPlan>(`/api/plans/${current.planId}`, secret);
          const details = await api<{ proposal: Proposal | null }>(`/api/plans/${current.planId}/proposal`, secret);
          if (live) { setPlan(saved); setProposal(details.proposal); }
        }
        if (current.dryRunId) {
          const saved = await api<DryRun>(`/api/dry-runs/${current.dryRunId}`, secret);
          if (live) setDryRun(saved);
        }
        if (live) { setApproved(current.approved); setPlanNeedsRefresh(current.planNeedsRefresh); }
        if (current.executionId) {
          const rec = await api<Reconciliation>(`/api/executions/${current.executionId}/reconciliation`, secret);
          if (live) { setExecution({ id: current.executionId, status: current.executionStatus ?? 'unknown' }); setReconciliation(rec); }
        }
        if (current.activeExecutionId && current.activeExecutionDatasetId && current.activeExecutionId !== current.executionId) {
          const [rec, schema] = await Promise.all([
            api<Reconciliation>(`/api/executions/${current.activeExecutionId}/reconciliation`, secret),
            api<Schemas>(`/api/datasets/${current.activeExecutionDatasetId}/schemas`, secret),
          ]);
          if (live) { setPriorActive({ id: current.activeExecutionId, status: 'committed' }); setPriorReconciliation(rec); setPriorTargetSchema(schema.target); }
        }
        const events = await api<{ events: HistoryEvent[] }>('/api/history', secret);
        const target = await api<{ rows: Record<string, unknown>[] }>('/api/target', secret);
        if (live) { setHistory(events.events); setTargetRows(target.rows); }
      } catch (cause) {
        if (live) reportError(cause);
      }
    })();
    return () => { live = false; };
  }, [ready, secret]);

  function reportError(cause: unknown) {
    if (cause instanceof ApiError && cause.status === 401) {
      sessionStorage.removeItem('reviewerKey');
      sessionStorage.removeItem('workbenchReady');
      setReady(false);
      setSecret('');
      setError('Reviewer access key is missing or incorrect. Copy REVIEWER_ACCESS_SECRET from Render and try again.');
      return;
    }
    setError(cause instanceof Error ? cause.message : 'Unexpected error');
  }

  async function action(label: string, work: () => Promise<void>) {
    setBusy(label); setError(''); setNotice('');
    try { await work(); }
    catch (cause) { reportError(cause); }
    finally { setBusy(''); }
  }

  async function refreshResults(executionId?: string) {
    const events = await api<{ events: HistoryEvent[] }>('/api/history', secret);
    const target = await api<{ rows: Record<string, unknown>[] }>('/api/target', secret);
    setHistory(events.events); setTargetRows(target.rows);
    if (executionId) setReconciliation(await api<Reconciliation>(`/api/executions/${executionId}/reconciliation`, secret));
  }

  async function refreshPlanVersions(datasetId: string) {
    const result = await api<{ versions: PlanVersion[] }>(`/api/datasets/${datasetId}/plans`, secret);
    setPlanVersions(result.versions);
  }

  function enterWorkbench() {
    if (busy) return;
    void action('checking-access', async () => {
      const key = secret.trim();
      await api<WorkbenchState>('/api/state', key);
      sessionStorage.setItem('reviewerKey', key);
      sessionStorage.setItem('workbenchReady', 'true');
      setSecret(key);
      setReady(true);
    });
  }

  function loadDataset() {
    void action('loading', async () => {
      const input = {
        sourceSchema: JSON.parse(sourceSchemaText) as unknown,
        targetSchema: JSON.parse(targetSchemaText) as unknown,
        records: JSON.parse(sourceText) as unknown,
        allowedRules: selectedRules,
      };
      const saved = await api<Dataset>('/api/datasets', secret, 'POST', input);
      const schemaDetails = await api<Schemas>(`/api/datasets/${saved.id}/schemas`, secret);
      setDataset({ ...saved, records: input.records as SourceRecord[], input: input as MigrationInput });
      setSchemas(schemaDetails);
      setPlanVersions([]);
      setInspectedVersion(null);
      setPlan(null); setProposal(null); setDryRun(null); setApproved(false); setPlanNeedsRefresh(false); setExecution(null); setReconciliation(null);
      setNotice(`Saved a new dataset with ${saved.count} rows.`);
      setStep(1);
      await refreshResults();
    });
  }

  function fillSample() {
    void action('sample', async () => {
      const sample = await api<MigrationInput>('/api/sample', secret);
      setSourceSchemaText(JSON.stringify(sample.sourceSchema, null, 2));
      setTargetSchemaText(JSON.stringify(sample.targetSchema, null, 2));
      setSourceText(JSON.stringify(sample.records, null, 2));
      setSelectedRules(sample.allowedRules);
      setNotice('Example inputs filled in. Save the snapshot to start a new plan.');
    });
  }

  function generateProposal(note = '', basePlanId?: string) {
    if (!dataset) return;
    void action('proposing', async () => {
      const saved = await api<{ planId: string; planVersion: number; proposal: Proposal & { plan: PlanData }; dryRun: DryRun }>(`/api/datasets/${dataset.id}/proposals`, secret, 'POST', { note, basePlanId });
      setPlan({ id: saved.planId, version: saved.planVersion, plan: saved.proposal.plan });
      await refreshPlanVersions(dataset.id);
      setProposal(saved.proposal); setDryRun(saved.dryRun); setApproved(false); setPlanNeedsRefresh(false); setExecution(null); setReconciliation(null);
      setRevisionNote(''); setAnswers({}); setAcknowledge(false); setStep(2);
      setNotice(`AI plan version ${saved.planVersion} and dry run are ready for final review.`);
    });
  }

  function inspectVersion(id: string) {
    void action('inspecting', async () => {
      setInspectedVersion(await api<SavedPlan>(`/api/plans/${id}`, secret));
    });
  }

  function approvePlan() {
    if (!plan || !dryRun) return;
    void action('approving', async () => {
      const { digest } = await api<{ digest: string }>(`/api/plans/${plan.id}/approval-digest?dryRunId=${dryRun.id}`, secret);
      await api(`/api/plans/${plan.id}/approve`, secret, 'POST', { dryRunId: dryRun.id, digest, actor, acknowledgeRejected: acknowledge, answers });
      setApproved(true); setNotice('This exact plan and dry run are approved for execution.');
    });
  }

  function executePlan() {
    if (!plan) return;
    void action('executing', async () => {
      const result = await api<Execution>(`/api/plans/${plan.id}/execute`, secret, 'POST');
      setExecution(result); setStep(4);
      setPriorActive(null); setPriorReconciliation(null); setPriorTargetSchema([]);
      await refreshResults(result.id);
      setNotice(`Migration committed: ${result.additionalInserts} new target rows.`);
    });
  }

  function retryExecution() {
    const selected = execution ?? priorActive;
    if (!selected) return;
    void action('retrying', async () => {
      const result = await api<Execution>(`/api/executions/${selected.id}/retry`, secret, 'POST');
      if (execution) { setExecution(result); await refreshResults(result.id); }
      else { setPriorActive(result); setPriorReconciliation(await api<Reconciliation>(`/api/executions/${result.id}/reconciliation`, secret)); await refreshResults(); }
      setNotice(`Retry completed with ${result.additionalInserts} additional inserts.`);
    });
  }

  function rollbackExecution() {
    const selected = execution ?? priorActive;
    if (!selected) return;
    void action('rolling-back', async () => {
      const result = await api<{ status: string; deleted: number }>(`/api/executions/${selected.id}/rollback`, secret, 'POST');
      if (execution) { setExecution({ ...execution, status: result.status }); await refreshResults(execution.id); }
      else { setPriorActive(null); setPriorReconciliation(null); setPriorTargetSchema([]); setApproved(false); setPlanNeedsRefresh(true); await refreshResults(); }
      setNotice(`Rollback removed ${result.deleted} rows owned by this execution.`);
    });
  }

  const shownExecution = execution ?? priorActive;
  const shownReconciliation = execution ? reconciliation : priorReconciliation;
  const shownTargetSchema = execution ? dataset?.input?.targetSchema ?? [] : priorTargetSchema;

  if (!ready) return <main className="access-shell"><section className="access-card">
    <div className="brand-mark">↗</div><p className="eyebrow">DATA MIGRATION WORKBENCH</p>
    <h1>Plan confidently.<br />Move data safely.</h1>
    <p className="muted">Review an AI-proposed mapping, test it against a small dataset, and approve before any records move.</p>
    <label className="field-label" htmlFor="reviewer-key">Reviewer access key</label>
    <input id="reviewer-key" type="password" value={secret} onChange={(event) => setSecret(event.target.value)} placeholder="Enter key if configured" onKeyDown={(event) => { if (event.key === 'Enter') enterWorkbench(); }} />
    {error && <p role="alert">{error}</p>}
    <button className="primary full" onClick={enterWorkbench} disabled={Boolean(busy)}>{busy === 'checking-access' ? 'Checking access…' : <>Open workbench <span>→</span></>}</button>
    <p className="fine-print">The key stays in this browser session. The local development server may allow access without one.</p>
  </section></main>;

  return <div className="app-shell">
    <aside className="sidebar">
      <div className="sidebar-brand"><div className="brand-mark">↗</div><div><strong>Migration<br />Workbench</strong><small>ONE SOURCE · ONE TARGET</small></div></div>
      <div className="sidebar-label">WORKFLOW</div>
      <nav aria-label="Workflow steps">{steps.map((label, index) => <button key={label} className={`nav-step ${step === index ? 'active' : ''}`} onClick={() => setStep(index)}><span className="step-number">{index + 1}</span>{label}</button>)}</nav>
      <div className="sidebar-footer"><span className="status-dot" /> Bounded sample workbench<br /><small>Up to 1,000 source records</small></div>
    </aside>
    <main className="content">
      <header className="topbar"><div><span className="eyebrow">AGENTIC DATA MIGRATION</span><h1>{steps[step]}</h1></div><div className="top-status"><span className="status-dot" />{step === 4 && priorActive && !execution ? 'Migration committed' : execution?.status === 'committed' ? 'Migration committed' : execution?.status === 'rolled_back' ? 'Migration rolled back' : planNeedsRefresh ? 'Plan needs refresh' : approved ? 'Plan approved' : dryRun ? 'Dry run ready' : plan ? 'Draft plan' : dataset ? 'Dataset ready' : 'Start with inputs'}</div></header>
      {error && <div className="alert error" role="alert"><strong>Action needed</strong><span>{error}</span><button onClick={() => setError('')} aria-label="Dismiss error">×</button></div>}
      {notice && <div className="alert success" role="status"><strong>Saved</strong><span>{notice}</span><button onClick={() => setNotice('')} aria-label="Dismiss notice">×</button></div>}

      {step === 0 && <section className="stack">
        <div className="intro"><h2>Define one migration</h2><p>Provide a source schema, a target schema, sample source records, and the allowed transformation rules. The AI will plan against the saved snapshot. Use synthetic records when testing an external AI model.</p></div>
        <div className="schema-grid">
          <div className="card"><div className="card-head"><div><h3>Source schema</h3><p>JSON array of fields: name, type, and whether required.</p></div><span className="pill">Editable</span></div><textarea className="json-input schema-input" spellCheck={false} value={sourceSchemaText} onChange={(event) => setSourceSchemaText(event.target.value)} aria-label="Source schema JSON" /><p className="fine-print">Types: string, integer, number, boolean. Up to 16 fields.</p></div>
          <div className="card"><div className="card-head"><div><h3>Target schema</h3><p>One required field must have unique: true to identify records.</p></div><span className="pill">Editable</span></div><textarea className="json-input schema-input" spellCheck={false} value={targetSchemaText} onChange={(event) => setTargetSchemaText(event.target.value)} aria-label="Target schema JSON" /><p className="fine-print">Optional constraints: maxLength, enum, or format (email, iso_datetime, country_code).</p></div>
        </div>
        <div className="card"><div className="card-head"><div><h3>Sample source records</h3><p>JSON array matching the source fields · 1–1,000 rows · entire input at most 1 MiB.</p></div><span className="pill">Editable</span></div><textarea className="json-input" spellCheck={false} value={sourceText} onChange={(event) => setSourceText(event.target.value)} aria-label="Source records JSON" /></div>
        <div className="card"><div className="card-head"><div><h3>Supported transformation rules</h3><p>Choose which safe, built-in rules the AI may use for this migration.</p></div><span className="pill">{selectedRules.length} selected</span></div><div className="rule-grid">{ruleCatalog.map((rule) => <label className="rule-option" key={rule.name}><input type="checkbox" checked={selectedRules.includes(rule.name)} onChange={(event) => setSelectedRules(event.target.checked ? [...selectedRules, rule.name] : selectedRules.filter((name) => name !== rule.name))} /><span><strong>{rule.name}</strong><small>{rule.effect}</small></span></label>)}</div></div>
        <div className="card"><h3>Save input snapshot</h3><p>Saving freezes these inputs for the next AI plan. Editing them later creates a new snapshot and requires a fresh plan and approval.</p><div className="button-row"><button className="primary" disabled={Boolean(busy)} onClick={loadDataset}>{busy === 'loading' ? 'Saving…' : 'Save migration inputs'}</button><button className="secondary" disabled={Boolean(busy)} onClick={fillSample}>Fill synthetic example</button></div></div>
        {dataset && <div className="card"><div className="card-head"><div><h3>Current saved snapshot</h3><p>{dataset.count ?? dataset.records?.length} records saved. Plans always use these saved inputs.</p></div><span className="pill green">Ready</span></div><button className="text-button" onClick={() => setStep(1)}>Continue to mapping plan →</button></div>}
        {schemas && <div className="schema-grid">
          {(['source', 'target'] as const).map((side) => <div className="card" key={side}><div className="card-head"><div><h3>Saved {side} schema</h3><p>Snapshot used by the AI and validation engine.</p></div><span className="pill">Saved</span></div><div className="table-scroll"><table><thead><tr><th>Field</th><th>Type</th><th>Constraint</th></tr></thead><tbody>{schemas[side].map((field) => <tr key={field.field}><td><code>{field.field}</code></td><td>{field.type}</td><td>{[field.required ? 'required' : 'optional', field.unique ? 'unique' : '', field.format ?? '', field.enum?.join(' / ') ?? ''].filter(Boolean).join(' · ')}</td></tr>)}</tbody></table></div></div>)}
        </div>}
      </section>}

      {step === 1 && <section className="stack">
        <div className="intro"><h2>Let the AI prepare the migration</h2><p>The agent inspects your saved schemas, records, and selected rules, creates every field mapping, validates the plan, and runs a dry run. You review the result before execution.</p></div>
        {!dataset ? <EmptyState message="Load a source dataset first." go={() => setStep(0)} /> : <>
          <div className="card"><div className="card-head"><div><h3>AI planning workflow</h3><p>One action prepares a complete mapping and dry-run preview. The agent never writes to the target.</p></div><span className="pill">Approval required</span></div><div className="button-row"><button className="primary" disabled={Boolean(busy)} onClick={() => generateProposal()}>{busy === 'proposing' ? 'Inspecting and validating…' : plan ? 'Generate new AI plan' : 'Generate AI plan and dry run'}</button></div></div>
          {proposal && <div className="card"><div className="card-head"><h3>AI assessment</h3><span className="pill purple">Proposal</span></div><p>{proposal.summary}</p>
            {proposal.risks.length > 0 && <div className="subsection"><h4>Risks</h4>{proposal.risks.map((risk, index) => <div className="risk" key={index}><span className={`severity ${risk.severity}`}>{risk.severity}</span><strong>{risk.field}</strong><span>{risk.explanation}</span></div>)}</div>}
            {proposal.assumptions.length > 0 && <div className="subsection"><h4>Assumptions</h4><ul>{proposal.assumptions.map((assumption, index) => <li key={index}>{assumption}</li>)}</ul></div>}
            {proposal.questions.length > 0 && <div className="subsection"><h4>Clarification questions</h4>{proposal.questions.map((question, index) => <p key={index}><strong>{question.field}:</strong> {question.question} {question.blocking && <span className="pill amber">Answer before approval</span>}</p>)}</div>}
          </div>}
          {plan && <div className="card"><div className="card-head"><div><h3>AI-selected field mappings</h3><p>Plan version {plan.version}. Source and target schemas remain unchanged.</p></div><span className="pill">{plan.plan.mappings.length} fields</span></div>
            <div className="table-scroll"><table><thead><tr><th>Target field</th><th>Source field</th><th>Supported rule</th><th>AI rationale</th></tr></thead><tbody>{plan.plan.mappings.map((mapping) => <tr key={mapping.target}><td><strong>{mapping.target}</strong></td><td>{mapping.sources.join(' + ')}</td><td><code>{mapping.rule}</code></td><td className="rationale">{proposal?.rationales.find((item) => item.target === mapping.target)?.reason ?? 'Review this mapping'}</td></tr>)}</tbody></table></div>
            {dryRun && <div className="button-row"><button className="primary" onClick={() => setStep(2)}>Inspect dry run →</button></div>}
          </div>}
          {planVersions.length > 0 && <div className="card"><div className="card-head"><div><h3>Saved plan versions</h3><p>Earlier versions are read-only. Only the latest version can move forward.</p></div><span className="pill">{planVersions.length} saved</span></div><div className="button-row">{planVersions.map((version) => <button className="secondary" key={version.id} onClick={() => inspectVersion(version.id)}>Version {version.version}{version.id === plan?.id ? ' · current' : ''}</button>)}</div>{inspectedVersion && <div className="subsection"><h4>Version {inspectedVersion.version} mappings</h4><div className="table-scroll"><table><thead><tr><th>Target</th><th>Source</th><th>Rule</th></tr></thead><tbody>{inspectedVersion.plan.mappings.map((mapping) => <tr key={mapping.target}><td>{mapping.target}</td><td>{mapping.sources.join(' + ')}</td><td><code>{mapping.rule}</code></td></tr>)}</tbody></table></div></div>}</div>}
        </>}
      </section>}

      {step === 2 && <section className="stack">
        <div className="intro"><h2>Preview the result</h2><p>The AI workflow has run the deterministic dry run without writing to the target. Invalid records are quarantined with field-level evidence.</p></div>
        {!plan ? <EmptyState message="Generate an AI plan first." go={() => setStep(1)} /> : <>
          {dryRun && <><div className="metric-grid"><Metric label="Source" value={dryRun.result.source} /><Metric label="Transformed" value={dryRun.result.transformed} /><Metric label="Accepted" value={dryRun.result.accepted} tone="good" /><Metric label="Quarantined" value={dryRun.result.rejected} tone="warn" /></div>
            <div className="card"><div className="card-head"><div><h3>Record evidence</h3><p>Expand a row to compare its original and transformed data.</p></div><span className="pill">{dryRun.result.rows.length} rows</span></div>
              <div className="record-list">{dryRun.result.rows.map((row) => <details key={row.row} className="record"><summary><span>Row {row.row}</span><span>{String(Object.values(row.original)[0] ?? '')}</span><span className={`row-status ${row.accepted ? 'accepted' : 'rejected'}`}>{row.accepted ? 'Accepted' : `${row.errors.length} issue${row.errors.length === 1 ? '' : 's'}`}</span></summary><div className="record-detail"><div><h4>Original</h4><pre>{JSON.stringify(row.original, null, 2)}</pre></div><div><h4>Transformed</h4><pre>{JSON.stringify(row.transformed, null, 2)}</pre></div></div>{row.errors.length > 0 && <div className="error-list">{row.errors.map((fieldError, index) => <p key={index}><strong>{fieldError.field}</strong> · {fieldError.message} <code>{fieldError.code}</code></p>)}</div>}</details>)}</div>
            </div><button className="primary" onClick={() => setStep(3)}>Review approval →</button></>}
        </>}
      </section>}

      {step === 3 && <section className="stack">
        <div className="intro"><h2>Approve before execution</h2><p>Approval covers this exact plan, source snapshot, target state, rules, and dry run. The server checks again when execution starts.</p></div>
        {priorActive && <div className="alert error"><strong>Another migration is active</strong><span>Roll it back before executing this plan. Its records and rollback controls are available in Reconciliation.</span><button className="text-button" onClick={() => setStep(4)}>View active migration →</button></div>}
        {planNeedsRefresh && plan && <div className="alert error"><strong>Target changed</strong><span>This dry run and approval no longer match the target. Ask the AI for a new plan version and review its fresh preview.</span><button className="text-button" onClick={() => generateProposal('Refresh the plan after the target state changed; inspect the current target and keep supported mappings where appropriate.', plan.id)}>Generate new plan →</button></div>}
        {execution?.status === 'rolled_back' && <div className="alert success"><strong>Migration rolled back</strong><span>Ask the AI to prepare a new plan version before another execution.</span><button className="text-button" onClick={() => plan && generateProposal('Prepare a new plan version after rollback.', plan.id)}>Generate new plan →</button></div>}
        {!dryRun || !plan ? <EmptyState message="Complete a dry run first." go={() => setStep(2)} /> : <>
          <div className="metric-grid compact"><Metric label="Plan version" value={plan.version} /><Metric label="Will insert" value={dryRun.result.accepted} tone="good" /><Metric label="Will quarantine" value={dryRun.result.rejected} tone="warn" /></div>
          <div className="card"><div className="card-head"><h3>Final AI plan</h3><span className="pill purple">Review before approval</span></div>{proposal && <p>{proposal.summary}</p>}
            <div className="table-scroll"><table><thead><tr><th>Target field</th><th>AI-selected source</th><th>Transformation</th></tr></thead><tbody>{plan.plan.mappings.map((mapping) => <tr key={mapping.target}><td>{mapping.target}</td><td>{mapping.sources.join(' + ')}</td><td><code>{mapping.rule}</code></td></tr>)}</tbody></table></div>
            {proposal && proposal.risks.length > 0 && <div className="subsection"><h4>Risks to review</h4>{proposal.risks.map((risk, index) => <div className="risk" key={index}><span className={`severity ${risk.severity}`}>{risk.severity}</span><strong>{risk.field}</strong><span>{risk.explanation}</span></div>)}</div>}
          </div>
          {!approved && !execution && <div className="card"><h3>Want the AI to revise this plan?</h3><p>Describe the concern. The agent will inspect and validate a new plan version and dry run; you will review it again before approval.</p><label className="field-label" htmlFor="revision-note">Revision request</label><textarea id="revision-note" className="revision-input" rows={3} maxLength={1000} value={revisionNote} onChange={(event) => setRevisionNote(event.target.value)} placeholder="For example: reconsider how the status field maps, and explain any rejected records." /><div className="button-row"><button className="secondary" disabled={Boolean(busy) || !revisionNote.trim()} onClick={() => generateProposal(revisionNote.trim(), plan.id)}>{busy === 'proposing' ? 'Revising…' : 'Ask AI to revise'}</button></div></div>}
          <div className="card"><h3>Human review</h3><label className="field-label" htmlFor="actor">Reviewer name</label><input id="actor" value={actor} onChange={(event) => setActor(event.target.value)} />
            {proposal?.questions.filter((question) => question.blocking).map((question, index) => <div key={index} className="question"><label className="field-label" htmlFor={`answer-${index}`}>{question.question}</label><input id={`answer-${index}`} value={answers[question.field] ?? ''} onChange={(event) => setAnswers({ ...answers, [question.field]: event.target.value })} placeholder="Your answer" /></div>)}
            <label className="checkbox"><input type="checkbox" checked={acknowledge} onChange={(event) => setAcknowledge(event.target.checked)} /><span>I reviewed the field mappings and acknowledge the {dryRun.result.rejected} quarantined records.</span></label>
            <div className="button-row"><button className="primary" disabled={Boolean(busy) || approved || planNeedsRefresh || !acknowledge || !actor.trim()} onClick={approvePlan}>{approved ? 'Approved' : busy === 'approving' ? 'Approving…' : 'Approve exact plan'}</button></div>
          </div>
          <div className="card execution-card"><div><h3>Execute migration</h3><p>Only accepted records enter the mock target. Retrying the same execution adds zero duplicates.</p></div><button className="primary" disabled={Boolean(busy) || !approved || planNeedsRefresh || Boolean(execution) || Boolean(priorActive)} onClick={executePlan}>{busy === 'executing' ? 'Executing…' : 'Execute approved plan →'}</button></div>
        </>}
      </section>}

      {step === 4 && <section className="stack">
        <div className="intro"><h2>Reconcile and review history</h2><p>Compare source and target totals, verify retries, and roll back only records owned by this migration.</p></div>
        {!shownExecution ? <EmptyState message="Execute an approved plan to see reconciliation." go={() => setStep(3)} /> : <>
          {priorActive && !execution && <div className="alert success"><strong>Earlier migration is active</strong><span>Manage this committed execution before starting the newer approved plan.</span></div>}
          {shownReconciliation && <><div className="metric-grid"><Metric label="Accepted source" value={shownReconciliation.accepted} /><Metric label="Target owned" value={shownReconciliation.ownedCount} /><Metric label="Target total" value={shownReconciliation.targetCount} /><Metric label="Reconciliation" value={shownReconciliation.matched ? 'Matched' : 'Mismatch'} tone={shownReconciliation.matched ? 'good' : 'warn'} /></div>
            <div className={`alert ${shownReconciliation.matched ? 'success' : 'error'}`}><strong>{shownReconciliation.matched ? shownExecution.status === 'rolled_back' ? 'Baseline restored' : 'Source and target totals match' : 'Reconciliation needs review'}</strong><span>{shownExecution.status === 'rolled_back' ? 'No rows from this execution remain in the target.' : 'Accepted rows match rows owned by this execution.'}</span></div></>}
          <div className="card"><div className="card-head"><div><h3>Target records</h3><p>{targetRows.length} rows currently in the mock target.</p></div><span className={`pill ${shownExecution.status === 'rolled_back' ? 'amber' : 'green'}`}>{shownExecution.status}</span></div>
            <div className="table-scroll"><table><thead><tr>{shownTargetSchema.map((field) => <th key={field.field}>{field.field}</th>)}</tr></thead><tbody>{targetRows.length === 0 ? <tr><td colSpan={shownTargetSchema.length || 1} className="empty-row">No target rows</td></tr> : targetRows.slice(0, 50).map((row, index) => <tr key={index}>{shownTargetSchema.map((field) => <td key={field.field}>{String(row[field.field] ?? '')}</td>)}</tr>)}</tbody></table></div>
            {targetRows.length > 50 && <p className="inline-note">Showing the first 50 target rows.</p>}
            <div className="button-row"><button className="secondary" disabled={Boolean(busy) || shownExecution.status !== 'committed'} onClick={retryExecution}>Retry safely</button><button className="danger" disabled={Boolean(busy) || shownExecution.status !== 'committed' || !shownReconciliation?.matched} onClick={rollbackExecution}>Roll back migration</button></div>
          </div>
        </>}
        <div className="card"><div className="card-head"><h3>Audit history</h3><span className="pill">{history.length} events</span></div><div className="timeline">{history.length === 0 ? <p className="muted">No events yet.</p> : [...history].reverse().slice(0, 30).map((event, index) => <div className="timeline-item" key={`${event.entity_id}-${index}`}><span className="timeline-dot" /><div><strong>{event.action.replaceAll('_', ' ')}</strong><small>{new Date(event.created_at).toLocaleString()}</small></div></div>)}</div></div>
      </section>}
    </main>
  </div>;
}

function EmptyState({ message, go }: { message: string; go: () => void }) {
  return <div className="empty-state"><div className="empty-icon">◇</div><h3>Nothing to review yet</h3><p>{message}</p><button className="secondary" onClick={go}>Go to required step →</button></div>;
}
