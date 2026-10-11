# Decision Lab

A local lab for typed decisions with Jev, Strands Decider, Clef, and configured System One services. Edit Noul, Choice, and Score questions, run individual inputs or experiment suites, label saved answers, and exchange YAML/JSON files with an LLM. Data is stored locally in SQLite.

## Quick start

Requires Node.js 22.16+ and npm.

```sh
npm install
cp .env.example .env
npm run dev
```

Open http://127.0.0.1:5173. Configure the selected provider before inference; Jev uses the server-side `TYPESAFE_API_KEY` in `.env`. Local providers run separately. Restart Node/Hono after configuration changes. For a production build, run `npm run build` and `npm start`, then open http://127.0.0.1:8787.

## Documentation

The in-app **Help** reads the same bundled Markdown as these files:

- [User guide](docs/user-guide.md): Playground → Evaluation, Suites → case evaluation → result export.
- [Exchange specification v1](docs/experiment-exchange.md): YAML/JSON contract, versions, grading, blindness, and HTTP API.
- [Connection settings](docs/connections.md): Jev, Strands Decider, Clef, and TOML connections.
- [Operations and development](docs/operations.md): setup, persistence, backups, migration, and verification.
- [Documentation index and historical plans](docs/README.md).

Ready-to-import [exchange examples](examples/exchange/) are available in YAML and JSON. Result examples are illustrative fixtures, not live model evaluations. Suite results are export-only; routing actions are not executed.

## License

Decision Lab is licensed under the [MIT License](LICENSE), copyright 2026 emguse and contributors. Third-party dependencies, the installed TypeSafe skill, and separately installed model/runtime components retain their own licenses; see [Third-Party Notices](THIRD_PARTY_NOTICES.md). Strands Decider, its v19 adapter/head, and the Qwen3.5 base model are Apache-2.0, not covered by this application's MIT grant.
