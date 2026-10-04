# Repository Guidelines

## Project Structure & Module Organization

`src/` contains the React UI and CSS. `server/` contains the Hono application, Jev provider adapter, and SQLite persistence. `shared/` holds Zod schemas and wire types shared by the UI and server. `tests/` contains Vitest tests; `tests/e2e/` contains Playwright browser tests. Generated bundles live in `dist/`, and the default SQLite database lives in `data/`; neither belongs in Git.

Keep provider-specific authentication and HTTP handling behind `DecisionProvider`. Keep UI rendering, request validation, and persistence separate so future Clef connections can reuse the editor and history.

## Build, Test, and Development Commands

Use Node.js 22.16+ and npm; commit `package-lock.json` when dependencies change.

- `npm install`: install dependencies.
- `npm run dev`: start Vite and the local Hono API.
- `npm run build`: type-check and build the frontend.
- `npm start`: serve the built application on loopback port 8787.
- `npm run check`: run the build and Vitest suite.
- `npm run test:e2e`: run Chromium UI tests after installing Playwright Chromium.
- `npm run test:live`: make one paid Jev request and save the result.

## Coding Style & Naming Conventions

Use strict TypeScript, two-space indentation, descriptive camelCase identifiers, and PascalCase React components. Retain provider wire names such as `input_tokens`. Keep runtime validation in Zod rather than relying on TypeScript alone. Run `npm run format` for Prettier formatting and `npm run format:check` to verify it. No standalone linter is configured. Avoid unrelated changes.

## Testing Guidelines

Name unit/integration tests `*.test.ts` and browser tests `*.spec.ts`. Cover migration/backup recovery, label provenance, per-evaluator blindness, profile switching, provider failures, and persistence. Browser tests mock `/api` and must not use real credentials. No coverage percentage is imposed. Paid API verification must be explicit and must never print credentials.

## Commit & Pull Request Guidelines

Use the established imperative commit style (`Add local Jev decision playground`). Use focused imperative subjects, such as `Add Jev response validation`. PRs should explain behavior, validation performed, and limitations; link relevant issues and include screenshots for UI changes.

## Security & Agent Instructions

Keep `.env` and API keys server-side and out of Git and logs. Bind local servers to loopback. Read and apply `.agents/skills/typesafe-ai/SKILL.md` when working on TypeSafe integrations, and verify changing contracts against official live documentation. Distinguish observed behavior from assumptions.

## Persistence Compatibility

Open persistent stores with `await Store.open(path)` so backup precedes migration. Keep released migrations immutable. Preserve legacy JSON, refuse unsupported future schema versions, and distinguish application/schema/record versions. Local user IDs are attribution, not authentication. Never return predictions through blind-labeling endpoints; finalized labels and reference adoption must remain revisioned.
