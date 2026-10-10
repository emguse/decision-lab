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

The browser receives only readiness status, never the key. Foreign browser origins are rejected. This app is intended for trusted local users, not public hosting. Draft saves do not call the provider. Image input, AI drafting, and batch evaluation are future extensions. Text/JSON Clef connections are available through TOML settings. Local Strands inference runs through a separate Python HTTP server. The current evaluation release labels already saved single-query results without another model request.

## Local users and blind evaluation

The identity bar selects a local user or creates one. UUIDs are stable; duplicate names do not merge identities. Experiments record their creator and runs record their executor. Selection is attribution only: **there is no login or access control**. Profiles are shared across browser tabs through local storage. Switching users or leaving annotation saves dirty labels first; failed saves prevent navigation. Requests retain the actor selected when they started.

New Playground executions default to blind mode. The API stores the full answer on the server but returns only input/questions and annotation status. In Evaluation, label Noul as Yes/No, choose a Choice option, and select a Score level. Labels start unset. Save an incomplete draft or finalize all labels to reveal answers and grading. To see answers immediately, uncheck blind execution before running; early reveal is also an explicit action in Evaluation.

Assign other local users as evaluators. Each user has an independent draft, label revisions, and reveal history. One evaluator's reveal does not reveal answers to another. All assigned evaluators must finalize before label comparison; adding an evaluator closes comparison until they finish. Compare disagreements and explicitly save adopted reference labels as a separate revision with source revisions; individual labels remain unchanged.

After reveal, label edits create a new revision marked post-reveal. Original revisions and settings are preserved. Noul uses `P(Yes) >= threshold` (default 0.5); Choice compares option IDs; Score uses unrounded absolute error and a tolerance (default 0.5 rubric levels). Show Noul/Choice correct counts and Score MAE separately. Threshold/tolerance changes regrade the stored response without paid requests. Adopted reference revisions can also be selected for grading after comparison.

Existing records are attributed to “旧データ・作成者不明”. Their exposure history is unknown, so labels on them are never claimed to be blind. Profile switching cannot protect against deliberate inspection or erase answers remembered outside the app. Human labels are reference judgments, not proof of objective truth. Forty questions on one state evaluate forty judgments on that state, not performance on forty independent cases.

## Database versions, backup, and recovery

Application release 0.3.0 uses SQLite schema 3 (`PRAGMA user_version`) and record format 1. Those versions serve different purposes. Migration 1 adds local identities/attribution; migration 2 adds evaluator assignments, drafts, exposure, and immutable label/reference revisions. Migration 3 adds provider metadata and original local responses in separate tables. Existing records default to Jev; original run/experiment JSON is retained byte-for-byte. New databases apply the same migrations. Future schema versions are rejected rather than downgraded.

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

## Local Strands Decider

Choose **Local · Strands Decider** in Playground. It needs no Jev key. Node/Hono connects to a separately running Python server; the browser never contacts Python directly. There is no automatic retry or cloud fallback. Saving an experiment preserves its provider; reopening uses the current server configuration. Model loading and downloads happen only when you launch Python.

Create a separate Python 3.12 virtual environment. The following installation targets the official source revision inspected for this adapter; its dependency ranges are upstream's, and the complete Python environment has not been run on this machine. Record `pip freeze` after a successful installation.

```sh
python3.12 -m venv /tmp/strands-venv
source /tmp/strands-venv/bin/activate
pip install "strands-decider @ git+https://github.com/strands-labs/strands-decider.git@75c9fd32e664954cdc18481434018aa507eee8fb"
strands-decider serve StrandsAgents/strands-decider-2B-hobson-v19 \
  --device mps --strict-window --port 8000
```

Use `--device cpu` for CPU-only machines; expect different latency. MPS targets Apple Silicon. MLX and CUDA have additional upstream installation requirements; consult the [official inference guide](https://github.com/strands-labs/strands-decider/blob/75c9fd32e664954cdc18481434018aa507eee8fb/docs/inference.md) before choosing those devices. The published adapter is about 92 MB; base weights download separately (about 4.55 GB), plus Python dependencies. Cache is normally under `~/.cache/huggingface/hub` (overridable through Hugging Face settings). Disk size is not runtime RAM. Measure initial loading, warm latency, and peak memory on the target machine; offline operation is unverified.

Add to `.env`, then restart Decision Lab:

```dotenv
LOCAL_DECISION_BASE_URL=http://127.0.0.1:8000
LOCAL_DECISION_MODEL=StrandsAgents/strands-decider-2B-hobson-v19
LOCAL_DECISION_TIMEOUT_MS=60000
```

Only explicit `127.0.0.1`/`[::1]` HTTP origins are accepted, with no credentials, path, query, or fragment; redirects are refused. Health checks expose only selected model/device/context fields, never checkpoint paths. The adapter expects the served model name to match the configured ID's final component. The official server ignores the request model selector: change its checkpoint by restarting Python, then update app configuration. Names do not verify exact weight revisions, which remain unknown in saved metadata.

This pinned runtime requires at least two Choice options and string-only Score levels. Structured state, instructions, Choice descriptions, and explicit Noul criteria are retained; unsupported Score criteria are rejected instead of converted. The inspected source revision supports `--strict-window` to reject oversized prompts; installed PyPI 0.1.0 does not. Check `strands-decider serve --help` before using that flag. PyPI 0.1.0 contains truncation paths, so short smoke tests do not establish reliable handling of long inputs. Health does not expose strict mode, so Decision Lab cannot verify that flag. Input overflow is shown as an error. Timeout can leave inference running on Python; check that process before manually retrying.

After Python is ready, use **接続を確認** and execute a blind query, or run `npm run test:local` with the Hono app running on port 8787. The script saves a Japanese three-question run, finalizes fixed fixture reference labels, and reloads its evaluation; it only selects the local provider and never calls Jev. It demonstrates the workflow, not general accuracy. Automated tests use mock wire fixtures; the live acceptance results and remaining limits are listed below. Japanese quality beyond the fixture, strict overflow rejection, complete memory use, and cold-start loading still require measurement.

Runs store requested/returned model names, reported device/base model, and original local JSON separately from normalized answers. Missing usage displays as unavailable. Local token counts describe that runtime's accounting, not Jev billing; confidence is provider-specific distribution concentration and should not be compared as a universal correctness score. Existing labels/revisions and legacy JSON are preserved by schema 3.

### Local acceptance (2026-10-04)

A user-prepared server at `127.0.0.1:8012` reported `strands-decider-2B-hobson-v19`, MPS, and a 4096-token window. A short Japanese input successfully returned all three answer types, was saved blind, finalized against fixed references, and displayed/reloaded through the browser. App round-trip time was 7314 ms on the first check and 1794 ms on a second identical check with the model already loaded. These two samples are not a latency benchmark. A sanitized response fixture is stored in `tests/fixtures/strands-v19-response.json`. No Jev calls were made.

Structured state and structured Noul instructions were accepted in a direct diagnostic request. A request containing structured/null option descriptions and structured Noul criteria was rejected with HTTP 422 by this installed runtime; the app preserves the input and reports incompatibility rather than coercing it. The runtime Git revision could not be established, and these results do not establish compatibility with every upstream revision. The installed package was subsequently identified as PyPI `strands-decider 0.1.0`; its CLI rejects `--strict-window`, and its source contains truncation paths. For short trials, keep the original launch command without that flag. For long-input evaluation, use a verified runtime with overflow rejection; the app cannot provide an equivalent token-level check by itself. Complete GPU/unified memory, cold load, strict overflow, and offline operation remain unverified.

### PyPI 0.1.0 versus the inspected source revision

The already installed PyPI 0.1.0 works for the tested short queries. Launch it without the unsupported option:

```sh
uv run strands-decider serve StrandsAgents/strands-decider-2B-hobson-v19 \
  --device mps --host 127.0.0.1 --port 8012
```

If overflow rejection is needed, the inspected official source revision contains that flag. From the separate Python project's directory, an explicit update can pin it:

```sh
uv add "strands-decider @ git+https://github.com/strands-labs/strands-decider.git@75c9fd32e664954cdc18481434018aa507eee8fb"
uv run strands-decider serve --help
```

This updates the Python project's dependency and lockfile; Decision Lab does not perform it. Stop the old server before relaunching with `--strict-window`, verify all three question types and actual overflow rejection, and record the new runtime/lockfile. Installation and full execution of this source revision remain unverified on this machine.

## License

Decision Lab is licensed under the [MIT License](LICENSE), copyright 2026 emguse and contributors. Third-party dependencies, the installed TypeSafe skill, and separately installed model/runtime components retain their own licenses; see [Third-Party Notices](THIRD_PARTY_NOTICES.md). Strands Decider, its v19 adapter/head, and the Qwen3.5 base model are Apache-2.0, not covered by this application's MIT grant.

## TOML System One connections

Copy `systemone.example.toml` to `systemone.toml`, edit it, and restart Node/Hono.
Alternatively set `SYSTEMONE_CONFIG_PATH` to a file path (relative paths use the
process working directory). Without a default file, existing Jev and Strands
settings work unchanged. An explicit missing file, unknown fields, duplicate or
reserved IDs (`jev`, `strands-local`), or invalid values prevent startup. Config
errors omit source lines and endpoints. TOML is loaded once; there is no hot reload.

Each `[[connections]]` defines `id` (lowercase letters/digits/hyphens, starting with
a letter, at most 64 characters), `label`, `adapter` (`llamacpp` or `systemone`),
`endpoint` (the complete POST URL), and default `model`. Optional `timeout_ms`
defaults to 60000 (range 100–600000). Optional `api_key_env` names a server-side
Bearer key environment variable; never put keys directly in TOML. Keys are never
inherited from Jev. Missing required credentials leave the connection unconfigured.
`question_interaction` is `independent`, `joint`, or `unknown` (default); this is
operator-supplied metadata, not a discovered model property. Use `joint` for Clef.
Local HTTP requires an explicit `127.0.0.1` or `[::1]` origin and `/v1/systemone`.
Other services require HTTPS. Redirects, embedded URL credentials, query strings,
and fragments are rejected. Never reference `TYPESAFE_API_KEY` for a local service.
HTTPS services must implement the [System One contract](https://docs.typesafe.ai/api)
and Bearer authentication when enabled; arbitrary custom authentication is not supported.

### Clef with llama.cpp v0.6.0

Install llama.cpp and obtain a compatible Clef GGUF separately, following upstream
instructions and the selected model's license. No model or runtime is bundled.
Start a text-only instance, replacing the model path and choosing a batch size that
fits your model/input and available memory:

```sh
llama-server --model /path/to/clef.gguf --alias clef --host 127.0.0.1 --port 8080 --ubatch-size 4096 --batch-size 4096
```

The example TOML uses model alias `clef` and port 8080. The app checks `/health` and
`/v1/models`, requiring the alias and `decisions` output modality before execution.
Older runtimes without that metadata cannot pass this adapter's readiness check.
Clef's full prompt must fit in `--ubatch-size`; 4096 is an example, not a guarantee
for every input. See the [v0.6.0 server documentation](https://github.com/ggml-org/llama.cpp/blob/v0.6.0/tools/server/README.md).
This app supports text/JSON only; no image-upload feature is included. Clef jointly
judges questions in one request, so changing one question can affect other answers.
No per-question splitting or semantic criteria conversion is performed. Structured
Score legends are preserved and displayed as JSON.

Generic `systemone` connections allow model editing and report configuration
readiness only: there is no universal health endpoint and the app does not make a
paid probe. A configured connection is not proof that its service is reachable.
The app never automatically retries or falls back to another provider.

Execution metadata format 2 snapshots the connection ID, label, adapter, question
interaction and requested/returned models. Original responses remain separate from
normalized answers and absent usage remains unavailable. Schema 3 and legacy JSON
remain unchanged; format 1 runs continue to load. Custom experiment metadata uses
format 2. Older application releases cannot read these new records. If a connection
is removed, saved records remain readable; execution requires an explicit new
selection. Reopening a fixed-model connection uses the current configured alias
without changing its stored snapshot. Token accounting and confidence are
provider-specific and must not be treated as universal billing or accuracy scores.
Browser tests use an isolated Vite server on loopback port 5175 and mock all API
requests; an occupied test port causes failure instead of reusing another app.
Automated tests use mock services. On 2026-10-10, the user reported successful
inference with llama.cpp v0.6.0 and cached `ggml-org/Clef-Flash-GGUF:Q4_K_M`
through router mode. The initial request was cancelled after about 60 seconds
while the model was loading; the connection timeout was increased to 300000 ms.
This confirms basic operation for that setup, not Japanese accuracy, a latency
benchmark, memory consumption, or overflow behavior.

When starting `llama serve` without a model, router mode uses the published
`/v1/models` IDs; `--alias clef` on the router does not rename its cached models.
For this setup, use `model = "ggml-org/Clef-Flash-GGUF:Q4_K_M"` in TOML.
Set `timeout_ms = 300000` if cold loading exceeds the default 60 seconds and
restart Node/Hono after editing the file. Router readiness checks confirm the
model ID and decision capability; they do not force model loading. The first
inference request can therefore take longer than subsequent requests.
