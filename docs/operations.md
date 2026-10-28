# Operations and development

For everyday use, see the [User guide](user-guide.md); for provider preparation, see [Connection settings](connections.md).

## Setup

Requires Node.js 22.16+ and npm. Jev uses a remote API; local inference requires a separately prepared runtime.

```sh
npm install
cp .env.example .env
```

Configure the provider you will use; see [Connection settings](connections.md). Jev requires server-side `TYPESAFE_API_KEY` in `.env`; local providers do not require that key. Never paste credentials into the frontend or commit them. Restart Node/Hono after changing configuration.

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

## Storage and architecture

- `src/`: React UI and styles.
- `shared/`: Zod wire schemas and shared types.
- `server/`: Hono routes, Jev provider adapter, SQLite store.
- `tests/`: unit/integration and Playwright tests.

The server uses Node's built-in SQLite (`node:sqlite`); the database defaults to `data/jev.sqlite`. Set `DATABASE_PATH` to change it. Back up the data directory with the application stopped. The UI lists the most recent 100 experiments and runs; older entries remain in the database. Evaluation uses direct run IDs rather than relying on the limited history list. State and responses may contain private data; they are sent to the selected provider and persisted locally.

Requests go to `POST https://api.typesafe.ai/v1/systemone` with server-side Bearer authentication. Each execution makes one request, with a 60-second timeout and no automatic retries. Concurrent executions are rejected. A timed-out request may still incur provider usage. If local persistence fails after a successful API call, execution reports an error; rerunning makes another paid request.

The browser receives only readiness status, never the key. Foreign browser origins are rejected. This app is intended for trusted local users, not public hosting. Draft saves do not call the provider. Image input is available through image-capable Strands and direct llama.cpp connections; AI drafting is a future extension. Suite execution and YAML/JSON exchange are available through the Suites workspace. Clef connections are available through TOML settings. Local Strands inference runs through a separate Python HTTP server. Evaluation labels saved single-query and Suite results without another model request.

## Database versions, backup, and recovery

Current development uses SQLite schema 6 (`PRAGMA user_version`) and supports record formats 1 and 2. Image-bearing Runs, Experiments, Suite executions and flow executions use format 2; legacy and text-only records retain format 1. Those versions serve different purposes. Migration 1 adds local identities/attribution; migration 2 adds evaluator assignments, drafts, exposure, and immutable label/reference revisions. Migration 3 adds provider metadata and original local responses in separate tables. Migration 4 adds immutable exchange documents, Suite executions, atomic run links, and per-user expected-reference familiarity. Existing records default to Jev; original run/experiment JSON is retained byte-for-byte. New databases apply the same migrations. Future schema versions are rejected rather than downgraded.

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
- [Installed TypeSafe skill](https://github.com/emguse/decision-lab/blob/main/.agents/skills/typesafe-ai/SKILL.md)

Strands connections use `systemone.toml`. Version 0.4 removes the old `LOCAL_DECISION_*` settings; see [Connection settings](connections.md) for migration. Saved legacy metadata remains readable.

## Image persistence and checks

Migration 5 adds deduplicated original image BLOBs, upload attribution, and ordered Run/Experiment references. Uploads and previews never include provider answers. Record creation and image references commit together; a missing image fails explicitly. SQLite backups include image bytes. Image reads update last-use time. On startup, uploads that have no saved references and have not been used for seven days are removed; saved images remain indefinitely. Keep a saved Experiment for unfinished work that must survive this cleanup window.

Only `POST /api/images` accepts up to 6 MiB of HTTP body; each decoded upload must be at most 5 MiB. Other API request bodies remain limited to 1 MiB. Actual image format, dimensions, static-image status, and full decoding are checked server-side using sharp before persistence. Image lists and saved Query JSON contain IDs rather than Base64.

Run `npm run check`, `npm run format:check`, and `npm run test:e2e` for mocked verification. For separately prepared local vision inference, start the built Hono app and run `npm run test:images:local -- /absolute/path/to/image.png`. This deliberately saves blind image and text runs and finalizes fixed smoke labels; it does not call Jev or install/download models. Reload the reported run IDs after restarting Hono to verify persistent history. Smoke labels are simple test rubrics, not domain accuracy evidence.

Implementation validation: automated fixtures cover original-byte retrieval, format/size/dimension limits, animation rejection, ordering, deduplication, atomic references, cleanup, schema migration/backup recovery, and blind projection isolation. On 2026-10-11, the user confirmed an image-bearing Strands run and its displayed result after preparing the pinned Git runtime with uv, the `vision` extra, and `transformers>=5.18,<6`. This is user-reported live acceptance, not an independently executed smoke script or a general accuracy benchmark. Runtime memory, timings, and restart acceptance were not measured by the agent. Automated validation passed the build, 69 Vitest tests, 26 Playwright tests, and formatting checks; the final image UI changes also passed all five image browser tests.

## Flow and Suite migration

Migration 6 adds immutable flow/Suite documents, execution snapshots, ordered image retention, separate local raw responses, per-evaluator exposures/assignments and finalized/reference revisions. It also retains image references in unexecuted schema-2 decision Suites. `Store.open` backs up earlier persistent databases before migration; released migrations 1–5 and old JSON remain unchanged. Restore the pre-migration backup to roll back rather than writing schema 6 with an older application. No production database was opened for implementation verification.

On restart, unfinished flow executions become interrupted. Retry with a fresh execution; no external effects are performed. Existing Suite resume behavior is unchanged. Flow and existing inference work share a single execution lock. Saved flow/Suite and execution references protect original image BLOBs from cleanup.
