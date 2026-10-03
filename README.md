# Jev Decision Lab

A local playground for TypeSafe AI's Jev decision models. Build Noul, Choice, and Score questions, inspect the request JSON, execute once, and explore probabilities. Experiments and successful runs are stored locally in SQLite.

## Setup

Requires Node.js 22.13+ (Node 24 LTS recommended) and npm. No Ollama or GPU is required.

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
5. Reopen an experiment or run from the sidebar to edit and rerun it. Results remain explicitly labeled as the prior execution's snapshot.

Choice/Score confidence describes distribution concentration, **not correctness**. Score is the probability-weighted rubric position. Noul has no separate confidence. Usage comes directly from the API; missing token counts display as unknown. Prices are not hardcoded.

## Storage and architecture

- `src/`: React UI and styles.
- `shared/`: Zod wire schemas and shared types.
- `server/`: Hono routes, Jev provider adapter, SQLite store.
- `tests/`: unit/integration and Playwright tests.

The server uses Node's built-in SQLite (`node:sqlite`); the database defaults to `data/jev.sqlite`. Set `DATABASE_PATH` to change it. Back up the data directory with the application stopped. The UI lists the most recent 100 experiments and runs; older entries remain in the database. State and responses may contain private data; they are sent to Jev and persisted locally.

Requests go to `POST https://api.typesafe.ai/v1/systemone` with server-side Bearer authentication. Each execution makes one request, with a 60-second timeout and no automatic retries. Concurrent executions are rejected. A timed-out request may still incur provider usage. If local persistence fails after a successful API call, execution reports an error; rerunning makes another paid request.

The browser receives only readiness status, never the key. Foreign browser origins are rejected. This app is intended for one trusted local user, not public hosting. Draft saves do not call the provider. Clef, image input, AI drafting, and batch evaluation are future extensions behind the provider interface.

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
