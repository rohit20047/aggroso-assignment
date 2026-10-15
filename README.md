# Migration Workbench

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

To try the full AI path, set `GEMINI_API_KEY` in the server environment. `GEMINI_MODEL` defaults to `gemini-3.5-flash-lite` and can be changed without code edits. The client uses Google's Gemini OpenAI-compatible REST endpoint. Keep the key on the server; never paste it into the browser. Google lists a limited free tier for this model, subject to account and regional availability and quotas. A live synthetic planning request succeeded with Flash-Lite. Without the key, the AI endpoint returns a clear unavailable response.

## Workflow

1. Enter source and target schema field definitions, paste 1–1,000 source records, and choose allowed rules from the catalog. The combined input is limited to 1 MiB. One required target field must be marked unique. The synthetic example can fill all four inputs.
2. Generate an AI plan. The agent selects all field mappings and supported rules; the server validates it and automatically runs a deterministic dry run. Each proposal creates an immutable version.
3. Inspect the plan, counts, original/transformed values, quarantined rows, and field errors. At final review, ask the AI for a revised version if needed; the user does not edit fields one by one.
4. Answer blocking clarification questions, acknowledge rejections, and approve the exact plan and dry run.
5. Execute into the mock target, reconcile counts (and minor-unit amounts when the example field is present), retry safely, and roll back rows owned by the execution. The audit trail survives restarts.

The AI workflow uses only five server-side, read-only inspection and validation tools: schema inspection, source profiling, selected-rule listing, mapping validation, and mapping preview. The server gathers bounded inspection results before the model call, validates and previews the model's plan, and requests one correction if needed. The model cannot execute a migration. The server checks human approval again at execution and applies transformations in deterministic code inside a SQLite transaction. The built-in catalog supports identity copy, trim, two-field join, lower/upper casing, status enum conversion, UTC timestamp normalization, and exact decimal-to-minor-unit conversion. The user chooses which of these are available for each snapshot; arbitrary code and unselected rules are rejected.

## Architecture and data

`web/` contains the React UI. `src/app.ts` defines the Fastify API. `src/agent.ts` and `src/gemini.ts` implement the bounded AI workflow. `src/domain.ts` owns transformation and validation. `src/store.ts` persists snapshots, plan versions, proposals, dry runs, approvals, attempts, target rows, and audit events in SQLite. `src/sample.ts` provides the synthetic demonstration dataset.

SQLite uses WAL mode and foreign keys. A user-designated unique target field and a unique execution per plan prevent duplicates. Generic target rows are stored as JSON in the mock target table. Execution and rollback use immediate transactions. Retrying a committed plan returns its original execution with zero additional inserts; a rolled-back plan needs a fresh plan and approval. Only one committed migration may be active at a time. If a newer plan is drafted while an earlier migration remains active, the UI links to its reconciliation and rollback controls. Rolling it back changes the target state, so the newer plan needs a fresh version and dry run before execution. The target is a local mock store, not a production integration.

## Deployment

For free hosting, use **Render Free + Neon PostgreSQL**. Follow [the step-by-step Render guide](DEPLOY_RENDER.md). The included `render.yaml` configures one Docker web service. Set `DATABASE_URL` to the private Neon connection string, plus `GEMINI_API_KEY`. The website and API open publicly without an access key; all visitors share the workbench and saved history. Plan approval is still required before execution. PostgreSQL tables are created at startup. A new Neon database starts empty; local SQLite history is not automatically imported. The server refuses to start on Render without `DATABASE_URL` so data cannot silently enter a disposable SQLite file. Render's free web service sleeps when idle; a first visit can be slow.

`src/postgres-store.ts` implements the hosted repository and `src/postgres-db.ts` manages pooled connections, parameterized queries, and transaction-scoped advisory locks. Each repository operation runs atomically; overlapping operations are serialized for this single shared workbench. AI network calls run outside database transactions. The local SQLite implementation remains available when `DATABASE_URL` is unset.

For SQLite deployment on another host, the `Dockerfile` builds both frontend and backend on Node.js 22. Set `GEMINI_API_KEY` as a private host variable; optionally set `GEMINI_MODEL`. With `DATABASE_URL` unset, set `DATABASE_PATH` to a **persistent mounted volume** (the image defaults to `/data/migration-workbench.db`), expose the host's `PORT`, and check `/health`. A disposable filesystem will lose SQLite plans, approvals, history, and target rows on restart. Use one app instance with one mounted database for this bounded workbench.

Do not put real credentials in the repository or reviewer notes. The bundled example and schema are suitable as reviewer sample inputs.

## Tests and limitations

`npm test` covers transformation errors, approval gating, immutable versions, duplicate-safe retries, rollback, API behavior, AI tool restrictions, database persistence across restart, and atomic insertion failure. `npm run typecheck` checks backend and frontend; `npm run build` creates `dist/` and `dist-web/`.

The scope is one source schema, one target schema, and up to 1,000 records per input snapshot. Schemas and rule selections are editable before saving; each saved version is immutable. User-written transformation code, production database access, distributed execution, and live connectors are outside this app. A Gemini key and deployment environment must be configured before the hosted AI workflow can be verified end to end.
