# Migration Workbench

**[Open the live demo](https://migration-workbench-0o4d.onrender.com/)** · [Source repository](https://github.com/rohit20047/aggroso-assignment) · Branch: `render-neon-deploy`

The demo opens directly without a login. It is one shared workbench with public access, so use the bundled synthetic records rather than private data.

A bounded data migration workbench with a TypeScript frontend and Fastify API. It accepts user-defined source and target schemas, sample source records, and a selected set of supported transformation rules. A Gemini model proposes a mapping, deterministic code previews it, human approval gates execution, and valid records enter a mock target backed by SQLite locally or PostgreSQL when hosted. Invalid rows remain in the dry-run evidence with field-level errors.

The bundled customer schemas and records are **synthetic example inputs chosen for this implementation**. They can be replaced on the Inputs screen. Each saved input snapshot freezes one source schema, one target schema, records, and selected rules for its plan versions; the AI does not edit the schemas. Use synthetic data when testing the external AI service: inspection previews may include transformed record values.

## Run locally

Use Node.js 22 or newer. Copy `.env.example` to `.env` and set private values in your environment. The app does not load `.env` automatically; use your shell, a process manager, or `node --env-file=.env` when starting the built server. Never commit the file.

```sh
npm ci
npm run typecheck
npm test
npm run build
node --env-file=.env dist/server.js
```

Open `http://localhost:3000`. For frontend development, run `npm run dev:web` separately; Vite proxies API calls to port 3000.

## Review the demo

1. Open **Inputs**, click **Fill synthetic example**, and **Save migration inputs**.
2. Click **Generate AI plan and dry run**. Inspect the selected source fields, supported transformations, explanations, risks, and saved version.
3. In **Dry run**, the standard example yields **20 source**, **18 transformed**, **14 accepted**, and **6 quarantined** records. Expand rejected rows to inspect the original data, transformed values, field names, and error codes. `Transformed` counts rows whose transformation rules completed; acceptance additionally checks source/target constraints and uniqueness.
4. In **Approval**, optionally ask the AI for a revision. This creates a new immutable version and dry run. Answer blocking questions, acknowledge quarantined rows, and approve the exact plan.
5. Execute the approved plan. **Reconciliation** should show 14 owned target rows and matched totals. **Retry safely** adds zero records. Refreshing the app restores the saved state.
6. **Roll back migration** removes the execution's target rows while retaining history. Create a new plan and approval to execute again. If another test migration is already active, use its reconciliation and rollback controls first.

The sample's rejected rows cover blank required names, invalid email, unsupported status, excessive decimal precision, and duplicate identifiers. AI plans can differ within the allowed rules; the counts above describe the standard mapping. The hosted workflow has been checked with a real Gemini plan and an AI revision to normalize email casing.

To try the full AI path, set `GEMINI_API_KEY` in the server environment. `GEMINI_MODEL` defaults to `gemini-3.5-flash-lite` and can be changed without code edits. The client uses Google's Gemini OpenAI-compatible REST endpoint. Keep the key on the server; never paste it into the browser. Google lists a limited free tier for this model, subject to account and regional availability and quotas. A live synthetic planning request succeeded with Flash-Lite. Without the key, the AI endpoint returns a clear unavailable response.

## Workflow

1. Enter source and target schema field definitions, paste 1–1,000 source records, and choose allowed rules from the catalog. The combined input is limited to 1 MiB. One required target field must be marked unique. The synthetic example can fill all four inputs.
2. Generate an AI plan. The agent selects all field mappings and supported rules; the server validates it and automatically runs a deterministic dry run. Each proposal creates an immutable version.
3. Inspect the plan, counts, original/transformed values, quarantined rows, and field errors. At final review, ask the AI for a revised version if needed; the user does not edit fields one by one.
4. Answer blocking clarification questions, acknowledge rejections, and approve the exact plan and dry run.
5. Execute into the mock target, reconcile counts (and minor-unit amounts when the example field is present), retry safely, and roll back rows owned by the execution. The audit trail survives restarts.

The AI workflow uses only five server-side, read-only inspection and validation tools: schema inspection, source profiling, selected-rule listing, mapping validation, and mapping preview. This is a server-orchestrated LLM workflow: the server gathers bounded inspection results before the model call, validates and previews the model's plan, and requests one correction if needed. The model cannot execute a migration. The server checks human approval again at execution and applies transformations in deterministic code inside a database transaction. The built-in catalog supports identity copy, trim, two-field join, lower/upper casing, status enum conversion, UTC timestamp normalization, and exact decimal-to-minor-unit conversion. The user chooses which of these are available for each snapshot; arbitrary code and unselected rules are rejected.

## Architecture and data

| Component | Implementation |
| --- | --- |
| React interface | `web/` |
| Fastify HTTP API and validation | `src/app.ts` |
| LLM planning, revision, and proposal validation | `src/agent.ts`, `src/gemini.ts` |
| Read-only inspection tool boundary | `src/tools.ts` |
| Deterministic transformations and schema checks | `src/domain.ts` |
| Local SQLite persistence | `src/store.ts` |
| Hosted PostgreSQL persistence and pooled transactions | `src/postgres-store.ts`, `src/postgres-db.ts` |
| Shared repository contract | `src/repository.ts` |
| Synthetic demonstration inputs | `src/sample.ts` |

Both repositories persist input snapshots, immutable plan versions, AI proposals, dry runs, approvals, execution attempts, mock target rows, and audit events.

SQLite uses WAL mode, foreign keys, and immediate transactions. Hosted PostgreSQL uses transactions and a transaction-scoped advisory lock to serialize this single workbench's operations. A user-designated unique target field and a unique execution per plan prevent duplicates. Generic target rows are stored as JSON in the mock target table. Retrying a committed plan returns its original execution with zero additional inserts; a rolled-back plan needs a fresh plan and approval. Only one committed migration may be active at a time. If a newer plan is drafted while an earlier migration remains active, the UI links to its reconciliation and rollback controls. Rolling it back changes the target state, so the newer plan needs a fresh version and dry run before execution. The target is a mock store in the application's database, not a production migration destination.

Fastify emits structured HTTP request and error logs. AI-workflow records in `llm_runs` include dataset, model, success/failure, inspection tool names, duration, and error code. The `audit_events` and `attempts` tables retain the workflow history shown in the UI. API keys are kept in the server environment and are not included in those workflow records.

## Deployment

For free hosting, use **Render Free + Neon PostgreSQL**. Follow [the step-by-step Render guide](DEPLOY_RENDER.md). The included `render.yaml` configures one Docker web service. Set `DATABASE_URL` to the private Neon connection string, plus `GEMINI_API_KEY`. The website and API open publicly without an access key; all visitors share the workbench and saved history. Plan approval is still required before execution. PostgreSQL tables are created at startup. A new Neon database starts empty; local SQLite history is not automatically imported. The server refuses to start on Render without `DATABASE_URL` so data cannot silently enter a disposable SQLite file. Render's free web service sleeps when idle; a first visit can be slow.

`src/postgres-store.ts` implements the hosted repository and `src/postgres-db.ts` manages pooled connections, parameterized queries, and transaction-scoped advisory locks. Each repository operation runs atomically; overlapping operations are serialized for this single shared workbench. AI network calls run outside database transactions. The local SQLite implementation remains available when `DATABASE_URL` is unset.

For SQLite deployment on another host, the `Dockerfile` builds both frontend and backend on Node.js 22. Set `GEMINI_API_KEY` as a private host variable; optionally set `GEMINI_MODEL`. With `DATABASE_URL` unset, set `DATABASE_PATH` to a **persistent mounted volume** (the image defaults to `/data/migration-workbench.db`), expose the host's `PORT`, and check `/health`. A disposable filesystem will lose SQLite plans, approvals, history, and target rows on restart. Use one app instance with one mounted database for this bounded workbench.

Do not put real credentials in the repository or reviewer notes. The bundled example and schema are suitable as reviewer sample inputs.

## Tests and limitations

`npm test` covers transformation errors, approval gating, immutable versions, duplicate-safe retries, rollback, API behavior, AI tool restrictions, database persistence across restart, and atomic insertion failure. `npm run typecheck` checks backend and frontend; `npm run build` creates `dist/` and `dist-web/`.

The scope is one source schema, one target schema, and up to 1,000 records and 1 MiB per input snapshot, with at most 16 fields per schema. Schemas and rule selections are editable before saving; each saved version is immutable. User-written transformation code, production migration destinations, distributed execution, and live source/target connectors are outside this app. Neon stores the application's mock state; it does not add a production migration connector.

The demo has no user accounts or separate per-visitor data. Public visitors share snapshots, history, and the Gemini quota. Keep the configured model available during review; free-host cold starts and provider quotas can delay or temporarily reject requests. The UI reports AI unavailability without executing a migration. Automated PostgreSQL tests use PGlite; they do not replace multi-connection load testing against a production PostgreSQL server.
