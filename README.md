# Jev Decision Lab

A local playground for TypeSafe AI's Jev decision models. Build Noul, Choice, and Score questions, inspect the request JSON, execute once, and explore probabilities. Experiments and successful runs are stored locally in SQLite.

## Setup

Requires Node.js 22.16+ (Node 24 LTS recommended) and npm. No Ollama or GPU is required.

```sh
npm install
cp .env.example .env
```

Set `TYPESAFE_API_KEY` in `.env` using your TypeSafe account's API key. Never paste keys into the frontend or commit them. Restart the server after changing the key.

```sh
npm run dev
```

Open http://127.0.0.1:5173. The UI is served by Vite; `/api` is proxied to the Hono server on `127.0.0.1:8787`. Both bind to loopback only.

For the built application:

```sh
npm run build
npm start
```

Open http://127.0.0.1:8787.

## Use

1. Edit the experiment name, model (`jev-latest` by default), and text or JSON state.
2. Add questions and select Noul (P(Yes)), Choice (named alternatives), or Score (ordered levels). In form mode, edit Choice options as key/value rows and Score levels as ordered rows; use +/− to add or remove them. Noul criteria are optional. Empty or duplicate keys and invalid level counts block saving and execution. Structured descriptions are preserved and can be edited in JSON mode.
3. Switch to JSON to inspect or edit the complete request. Invalid drafts block saving and execution; repair them before switching views.
4. Save the experiment, or execute it once. Execution automatically saves an immutable snapshot of the query, response, timestamp, returned model, and elapsed milliseconds.
5. Reopen an experiment from the sidebar to edit and rerun it. Run history opens Evaluation; use the copy action to return its input to Playground. Results remain explicitly labeled as the prior execution's snapshot.

Choice/Score confidence describes distribution concentration, **not correctness**. Score is the probability-weighted rubric position. Noul has no separate confidence. Usage comes directly from the API; missing token counts display as unknown. Prices are not hardcoded.

## Storage and architecture

- `src/`: React UI and styles.
- `shared/`: Zod wire schemas and shared types.
- `server/`: Hono routes, Jev provider adapter, SQLite store.
- `tests/`: unit/integration and Playwright tests.

The server uses Node's built-in SQLite (`node:sqlite`); the database defaults to `data/jev.sqlite`. Set `DATABASE_PATH` to change it. Back up the data directory with the application stopped. The UI lists the most recent 100 experiments and runs; older entries remain in the database. Evaluation uses direct run IDs rather than relying on the limited history list. State and responses may contain private data; they are sent to Jev and persisted locally.

Requests go to `POST https://api.typesafe.ai/v1/systemone` with server-side Bearer authentication. Each execution makes one request, with a 60-second timeout and no automatic retries. Concurrent executions are rejected. A timed-out request may still incur provider usage. If local persistence fails after a successful API call, execution reports an error; rerunning makes another paid request.

The browser receives only readiness status, never the key. Foreign browser origins are rejected. This app is intended for one trusted local user, not public hosting. Draft saves do not call the provider. Clef, image input, AI drafting, and batch evaluation are future extensions. The current evaluation release labels already saved single-query results without another model request.

## Local users and blind evaluation

The identity bar selects a local user or creates one. UUIDs are stable; duplicate names do not merge identities. Experiments record their creator and runs record their executor. Selection is attribution only: **there is no login or access control**. Profiles are shared across browser tabs through local storage. Switching users or leaving annotation saves dirty labels first; failed saves prevent navigation. Requests retain the actor selected when they started.

New Playground executions default to blind mode. The API stores the full answer on the server but returns only input/questions and annotation status. In Evaluation, label Noul as Yes/No, choose a Choice option, and select a Score level. Labels start unset. Save an incomplete draft or finalize all labels to reveal answers and grading. To see answers immediately, uncheck blind execution before running; early reveal is also an explicit action in Evaluation.

Assign other local users as evaluators. Each user has an independent draft, label revisions, and reveal history. One evaluator's reveal does not reveal answers to another. All assigned evaluators must finalize before label comparison; adding an evaluator closes comparison until they finish. Compare disagreements and explicitly save adopted reference labels as a separate revision with source revisions; individual labels remain unchanged.

After reveal, label edits create a new revision marked post-reveal. Original revisions and settings are preserved. Noul uses `P(Yes) >= threshold` (default 0.5); Choice compares option IDs; Score uses unrounded absolute error and a tolerance (default 0.5 rubric levels). Show Noul/Choice correct counts and Score MAE separately. Threshold/tolerance changes regrade the stored response without paid requests. Adopted reference revisions can also be selected for grading after comparison.

Existing records are attributed to “旧データ・作成者不明”. Their exposure history is unknown, so labels on them are never claimed to be blind. Profile switching cannot protect against deliberate inspection or erase answers remembered outside the app. Human labels are reference judgments, not proof of objective truth. Forty questions on one state evaluate forty judgments on that state, not performance on forty independent cases.

## Database versions, backup, and recovery

Application release 0.2.0 uses SQLite schema 2 (`PRAGMA user_version`) and record format 1. Those versions serve different purposes. Migration 1 adds local identities/attribution; migration 2 adds evaluator assignments, drafts, exposure, and immutable label/reference revisions. Original run/experiment JSON is retained byte-for-byte. New databases apply the same migrations. Future schema versions are rejected rather than downgraded.

Before upgrading an existing database, startup uses SQLite's backup API to create `<database>.backup-v<version>-<timestamp>-<uuid>.sqlite`. This is a consistent backup including committed WAL data. Backup failure prevents migration. Each migration is transactional, including its version update; failure rolls back that migration and stops startup. Keep the automatically generated backups until the upgrade has been verified. Stop older application processes before upgrading; old releases are not safe writers for newer schemas.

To restore, stop **all** application processes, preserve the current database and its `-wal`/`-shm` files elsewhere, then replace the database with the selected backup. Do not leave WAL/SHM files from the replaced database alongside the restored file. Use the application version compatible with that backup; starting a newer release will migrate it again. The application never silently restores, deletes, or downgrades data.

## Verification

```sh
npm run check       # TypeScript, production build, unit/integration tests
npx playwright install chromium
npm run test:e2e    # Browser tests with mocked API; no paid calls
npm run test:live   # One paid request with all three question types
```

Live verification requires a configured `.env`. It validates the real response and persists a `Live API smoke test` run using the same application endpoint; it outputs only model, usage, and timing. Run it explicitly when you want a paid connectivity check.

## References

- [TypeSafe HTTP API](https://docs.typesafe.ai/api)
- [Decision primitives](https://docs.typesafe.ai/primitives)
- [Confidence](https://docs.typesafe.ai/confidence)
- [Installed TypeSafe skill](.agents/skills/typesafe-ai/SKILL.md)
