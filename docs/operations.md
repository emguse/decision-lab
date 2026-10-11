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

The browser receives only readiness status, never the key. Foreign browser origins are rejected. This app is intended for trusted local users, not public hosting. Draft saves do not call the provider. Image input and AI drafting are future extensions. Suite execution and YAML/JSON exchange are available through the Suites workspace. Text/JSON Clef connections are available through TOML settings. Local Strands inference runs through a separate Python HTTP server. Evaluation labels saved single-query and Suite results without another model request.

## Database versions, backup, and recovery

Application release 0.4.0 uses SQLite schema 4 (`PRAGMA user_version`) and record format 1. Those versions serve different purposes. Migration 1 adds local identities/attribution; migration 2 adds evaluator assignments, drafts, exposure, and immutable label/reference revisions. Migration 3 adds provider metadata and original local responses in separate tables. Migration 4 adds immutable exchange documents, Suite executions, atomic run links, and per-user expected-reference familiarity. Existing records default to Jev; original run/experiment JSON is retained byte-for-byte. New databases apply the same migrations. Future schema versions are rejected rather than downgraded.

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
