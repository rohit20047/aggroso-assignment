# Agent usage

## Tools and responsibility

A coding assistant helped design and implement the React/TypeScript frontend,
Fastify API, deterministic migration engine, database repositories, tests, and
deployment documentation. Tools included the local terminal, TypeScript compiler,
Vitest, Git/GitHub CLI, Chrome browser automation, and official hosting/API
documentation. No work was delegated to subagents. The implementation and its
limits must still be understood and owned by the developer.

## Representative prompts

These are paraphrased development requests, not a transcript:

- Build a bounded migration workflow with AI-proposed mappings, deterministic
  validation, and explicit approval before execution.
- Let users supply source/target schemas, sample records, and selected supported
  rules, then freeze each saved input snapshot.
- Preserve plan versions and field-level rejection evidence; make retries safe,
  reconcile totals, and support rollback without removing history.
- Deploy the app on Render Free with durable Neon storage and automatic updates
  from the GitHub deployment branch.
- Remove the reviewer-key entry screen and make the website/API public, while
  retaining approval of the exact migration plan before execution.

## Runtime AI boundary

The server orchestrates five read-only tools: schema inspection, source profiling,
selected-rule listing, mapping validation, and mapping preview. It supplies the
bounded inspection results to Gemini, validates the returned full proposal, runs a
deterministic preview, and requests one correction if validation fails. This is an
LLM workflow with server-controlled inspection, rather than unrestricted autonomous
tool selection. The model cannot execute migrations or run arbitrary code.

Schemas and allowed rules remain under user control. AI proposals include field
mappings, explanations, risks, assumptions, and clarification questions. The server
checks blocking answers, rejected-row acknowledgement, plan/dry-run digests, latest
version, and target state before execution. Source data is treated as untrusted
content. Only synthetic records were used for live model verification.

## Mistakes and rejected approaches

- Vitest initially searched under the frontend root and found no tests. The test
  command now explicitly uses the repository root.
- Some model responses contained unsupported or incomplete mappings, timed out, or
  hit quota limits. Invalid drafts were rejected; they never became executable
  target writes. One repair attempt is allowed.
- Gemini sometimes returned fenced JSON, a target-keyed plan, or partial revision
  explanations. Parsing accepts these bounded shapes while still validating every
  mapping. Prior explanations are retained only for unchanged mappings.
- Local SQLite on Render Free would lose history on restart. The hosted app uses
  PostgreSQL through `DATABASE_URL`; startup on Render rejects a missing URL.
- The original entry screen opened before checking access. This was corrected,
  then the entry-key mechanism was removed at the user's explicit request for a
  public shared workbench. Migration approval remains separate from website access.
- A PGlite persistence test hit Windows temporary-directory cleanup failures. It
  now exports and restores a PostgreSQL data-directory snapshot.

## Verification

The local suite contains 30 tests covering transformations and error evidence,
custom schemas and selected rules, approval gating, immutable versions, stale
state, AI tool restrictions and repair, duplicate-safe retries, reconciliation,
rollback, persistence, and atomic insertion failure. Type checks cover frontend
and backend; the production build compiles both. Model contract tests use a fake
client and are distinguished from live provider testing.

On the hosted app, a real Gemini proposal and a requested email-normalization
revision created plan versions 1 and 2. The synthetic dry run reported 20 source,
18 transformed, 14 accepted, and 6 quarantined rows. The test explicitly approved the exact plan before execution;
14 mock target rows were committed with matched totals, and retry added zero rows.
Render successfully built the Docker image, connected to Neon, and automatically
deployed a GitHub push. No application submission was made during these checks.

PostgreSQL unit/integration tests use PGlite's local PostgreSQL engine and a
serialized test connection. Production uses pooled connections and a
transaction-scoped advisory lock. The tests do not establish production load
capacity or prove every possible concurrency case. The public demo shares state
and AI quota across visitors and is intended for synthetic review data.
