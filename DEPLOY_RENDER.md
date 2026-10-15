# Deploy on Render Free with Neon

Render hosts the React UI and Fastify API together. Neon stores the workbench
database independently, so Render restarts and redeployments retain saved work.
Local development can still use SQLite. Setting `DATABASE_URL` selects PostgreSQL;
the server creates its tables automatically at startup. A new Neon database starts
empty; this does not copy any existing local SQLite history.

## 1. Put the app on GitHub

Create a GitHub repository and push this project, including the latest changes and
`render.yaml`. Use the branch containing your finished app. The `.gitignore`
excludes `.env`, local databases, build outputs, and private assignment notes.
Check the files before pushing. For this project, use
[`rohit20047/aggroso-assignment`](https://github.com/rohit20047/aggroso-assignment)
and select the `render-neon-deploy` branch in Render.

## 2. Create the free Neon database

1. Sign in at [Neon](https://console.neon.tech/).
2. Create a project named `migration-workbench` on the **Free** plan.
3. Choose a region close to your intended Render service region.
4. Open **Connect** and copy the PostgreSQL connection string. Use the pooled
   connection if offered and keep the SSL parameters included by Neon.
5. Save it privately for the `DATABASE_URL` setting below. Do not paste the
   connection string into GitHub or the chat.

## 3. Create the Render service

1. Sign in at [Render](https://dashboard.render.com/).
2. Choose **New → Blueprint** and connect the GitHub repository.
3. Choose the branch containing `render.yaml`. Render reads that file to create
   one Docker web service on the **Free** plan.
4. Supply the requested secret values:

   | Variable | Value |
   | --- | --- |
   | `DATABASE_URL` | The full Neon connection string |
   | `GEMINI_API_KEY` | Your existing Gemini API key |

5. Confirm the service uses **Free**, then deploy. The Blueprint supplies
   `NODE_ENV=production`, sets the current Gemini model default, generates a
   reviewer secret, and uses `/health` as the health check.
6. After creation, open the service's **Environment** settings and reveal/copy
   the generated `REVIEWER_ACCESS_SECRET`. Use that value in the app's reviewer
   access field. Keep it private, apart from the intended reviewer.

The Dockerfile builds both frontend and API using Node.js 22. No separate static
site, build command, start command, disk, or frontend API URL is needed. Render
supplies `PORT`; the server listens on `0.0.0.0`.

### Alternative: manual Web Service setup

If you use **New → Web Service**, connect the same repository and select:

| Setting | Value |
| --- | --- |
| Language/runtime | Docker |
| Root directory | Leave blank for this repository |
| Dockerfile path | `./Dockerfile` |
| Instance type | Free |
| Health check path | `/health` |

Add `DATABASE_URL`, `GEMINI_API_KEY`, `NODE_ENV=production`,
`GEMINI_MODEL=gemini-3.5-flash-lite`, and a long random
`REVIEWER_ACCESS_SECRET` under Environment. PowerShell can generate a reviewer
secret locally with:

```powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

The local `DATABASE_PATH` setting is unused when `DATABASE_URL` is set. The app
refuses to start on Render without `DATABASE_URL`, preventing accidental use of
Render's disposable local filesystem.

## 4. Verify the deployment

1. Wait for **Live**, then open the service's `https://…onrender.com` address.
   `/health` should return `{"status":"ok"}`.
2. Enter the reviewer access secret. Load the bundled synthetic example.
3. Generate an AI plan; inspect its dry run and rejected rows. The unmodified
   bundled mapping accepts 14 of the 20 sample records and rejects 6.
4. Answer any blocking questions, acknowledge rejected rows, and approve.
5. Execute, check reconciliation, and retry. A retry must add zero rows.
6. Redeploy the same commit in Render, then reopen the app. The plan, execution,
   target rows, and audit history should still be present in Neon.
7. Roll back and confirm the execution's rows are removed while history remains.

The same workbench is shared by everyone using its reviewer key. Use synthetic
data for the hosted demo. Keep it available until review is complete.

## Troubleshooting

- **`DATABASE_URL is required on Render`:** Add the Neon connection string to
  the service environment and redeploy.
- **Database connection or SSL failure:** Copy a fresh connection string from
  Neon, including its SSL query parameters. Confirm that the password and database
  name are correct. Do not disable SSL verification to work around it.
- **401 / Reviewer access required:** Use the current Render environment value
  of `REVIEWER_ACCESS_SECRET` in the app.
- **AI unavailable:** Check `GEMINI_API_KEY`, model access, and the provider's
  quota. Review Render logs for the error. Gemini free-tier eligibility and quotas
  are separate from hosting.
- **Slow first visit:** Render Free sleeps after 15 minutes without inbound
  traffic. Wait for it to wake; Neon may also need to wake its compute.
- **Build fails:** Check the Render build log. Keep the runtime set to Docker so
  it uses the repository's Node.js 22 image.

## Free service limits

Free hosting is subject to each provider's quotas. Check current terms before
creation: [Render Free](https://render.com/docs/free),
[Neon pricing](https://neon.com/pricing),
[Render Blueprints](https://render.com/docs/infrastructure-as-code).
Avoid Render's free PostgreSQL database for this deployment; its free database
expires after 30 days. This guide uses Neon for persistent storage instead.

## Validation scope

The automated suite exercises SQLite and PostgreSQL workflow behavior. PostgreSQL
tests run with PGlite, a local PostgreSQL engine, covering rollback, stale approvals,
concurrent requests, API/AI inspection, and restoring a persisted database snapshot.
The test pool serializes its single connection; production uses transaction-scoped
PostgreSQL advisory locks across pooled connections. Hosted Neon connectivity,
cross-connection locking, the Docker image build, and the live deployment still
need verification in the deployment environment.
