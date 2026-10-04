# Local Decision Provider Implementation Plan

## Goal and scope

Extend Decision Lab with an explicitly selected local HTTP provider for Strands Decider, retaining Jev, Playground, saved experiments, local identities, and blind evaluation. Start with `StrandsAgents/strands-decider-2B-hobson-v19`. The Python inference server runs separately and keeps its model loaded; Node/Hono owns validation, execution, attribution, and persistence. The browser connects only to Hono.

This change is planned on `codex/local-decision-provider`, based on evaluation commit `61e0b1e`. Implementation was authorized after plan review. Python model setup remains a separate operator step. Python packaging into a desktop application, automatic process management, model downloads from the UI, Ollama/llama.cpp integration, images, batch evaluations, automatic model comparison, and automatic cloud fallback are deferred.

## Verified contract and open questions

Official documentation checked on 2026-10-04:

- Strands provides `POST /v1/systemone`, `GET /health`, and Noul/Choice/Score questions. Default binding is `127.0.0.1`; no authentication is provided. Health includes model/checkpoint/base/device/calibration information.
- The documentation explicitly states that compatibility with Jev itself and concurrent-request behavior are unverified. Endpoint similarity is not evidence of complete compatibility.
- State and option descriptions can be structured. Default inference can truncate oversized state; `--strict-window` rejects overflow with HTTP 422. Use strict mode for evaluation. `--max-batch` controls internal question batches; it does not introduce a Decision Lab dataset runner.
- The published checkpoint is an adapter plus a head. Base weights download separately. Do not advertise a complete 2 GB download or promise a fixed RAM requirement.
- CPU, MPS, CUDA, and optional MLX paths are documented. Device extras may require installation from a pinned repository revision rather than the published package; verify available releases during implementation.

Before adapting responses, capture actual health and three-question fixtures. Check structured instructions/criteria, explicit Noul criteria, null Choice descriptions, Score legends, usage, model selection behavior, and overflow errors. Verify whether the request model field selects a model, is ignored, or is validated. A URL alone must never imply that a different model was loaded.

Sources: [Strands inference](https://github.com/strands-labs/strands-decider/blob/main/docs/inference.md), [checkpoint](https://huggingface.co/StrandsAgents/strands-decider-2B-hobson-v19), [TypeSafe API](https://docs.typesafe.ai/api).

## Architecture and configuration

Keep `DecisionProvider` as the common boundary. Add `LocalDecisionProvider` and a registry keyed by `jev` and `strands-local`. Select the provider separately from the model question payload; never send app-specific selection fields upstream. Resolve the actor, provider, model, and configured endpoint at request start. Preserve the existing global execution gate, including requests to different providers. No automatic retries or fallback.

Proposed server configuration:

```dotenv
LOCAL_DECISION_BASE_URL=http://127.0.0.1:8000
LOCAL_DECISION_MODEL=StrandsAgents/strands-decider-2B-hobson-v19
LOCAL_DECISION_TIMEOUT_MS=60000
```

The base URL is configured server-side, not supplied by each browser request. Accept HTTP on explicit loopback addresses only (`127.0.0.1` or `[::1]`), with a valid port and no credentials, query, fragment, or arbitrary base path. Reject redirects (`redirect: 'error'`) and non-loopback targets. Never attach the Jev bearer key to local requests. Preserve existing Hono loopback/origin/body restrictions. Use fixed health and inference paths.

Expose provider availability and a sanitized local health summary through the configuration API. Distinguish unconfigured, unreachable, ready, and model mismatch states. Health checks have a short bounded timeout and never execute a judgment; perform on selection/manual refresh rather than frequent polling. Do not expose checkpoint filesystem paths. A failed health probe must not prevent using Jev. Validate timeout configuration at startup.

## Request and response handling

Extend the app execution envelope with an optional provider ID, defaulting to Jev for legacy callers. Keep the existing question payload and editor synchronization. Add provider-specific capability validation before forwarding rather than silently dropping unsupported criteria or changing their meaning. Never mutate an experiment's stored query merely to make another backend accept it.

Keep normalized answers compatible with the existing grader and result components. Validate question IDs, answer types, option membership, distributions, confidence ranges, Score bounds, and legends. If contract differences require an adapter, keep the original JSON separately from normalized data and document each conversion. Do not invent missing confidence, token counts, or model identifiers. Represent unavailable usage as unavailable and update presentation accordingly. Provider latency is optional; client-measured round-trip elapsed time remains distinct.

Map connection refusal, timeout, HTTP 422/input overflow, unavailable model/OOM, and malformed responses to actionable errors without leaking arbitrary upstream bodies. Preserve input and labels on failure. Timeout may leave Python inference running; do not resend automatically, and document this limitation. No failed request becomes a successful saved result.

## UI and workflow

Add a provider selector to Playground: Jev API or Local · Strands Decider. Default to Jev for existing installations; retain the last explicit selection locally. Show connection readiness and the loaded local model. Local mode requires no Jev key. The local model is loaded by the Python server, so the UI must not present its model field as a hot-swap control.

Keep server configuration and local capability messages distinct from Jev setup errors. Provide a small connection-check action and setup guidance when local inference is unavailable. Switching providers does not execute, reveal answers, reset state/questions, or discard dirty evaluation labels. Reopening a saved experiment restores its provider explicitly; an unavailable provider produces a configuration message rather than silently selecting Jev.

Blind runs retain answer-free execution and history projections. Health/model information is configuration data, not grading feedback. Finalization, drafts, revisions, evaluator isolation, comparison, adoption, and local regrading continue to operate on the saved response without calling either provider. Profile switching during inference retains the original actor and cannot display old-user results.

## Persistence and compatibility

Add immutable schema migration 3 with additive execution/experiment metadata tables; leave migrations 1 and 2 and existing JSON bodies unchanged. Existing records are known Jev records under the current implementation; missing historical model revisions/runtime details remain unknown. Preserve their separate legacy creator and exposure provenance.

Record provider ID, requested model, returned model, and execution metadata alongside each new run; save provider selection alongside each experiment. Record runtime/device/checkpoint revision only when actually reported or explicitly configured with provenance. A health name or mutable Hub ID is not proof of an exact artifact revision. Mark unavailable fields unknown. Do not store API keys, raw health paths, or the local endpoint as a portable experiment destination. Reopening uses the current server configuration.

Separate original provider response from normalized response if normalization is needed; preserve existing Jev raw-response display. Give new metadata its own format version, reject unsupported future formats, and retain legacy payload format 1. Continue consistent backup before pending migrations, foreign-key enforcement, rollback, and newer-schema refusal. Keep application release, schema, and record versions distinct. Update recovery documentation and bump the application version for delivery after deciding the final metadata format.

## Python setup and acceptance

Use a separate virtual environment and a pinned tested package version or Git revision. Do not add Python dependencies to npm installation. Document MPS first on Apple Silicon, CPU as a functional fallback, and MLX/CUDA only with verified setup instructions. Include model/base download size, cache location, initial load versus warm execution, and runtime RAM measurement. Do not claim offline operation until a warmed cache is tested without network.

Target launch, subject to verification against the pinned runtime:

```sh
strands-decider serve StrandsAgents/strands-decider-2B-hobson-v19 \
  --device mps --strict-window --port 8000
```

Provide a separate local smoke script that uses the same Hono execution endpoint with explicit `strands-local`, saves a run, and never falls back to Jev. A smoke invocation requires the separately running server; no automatic multi-gigabyte download is part of the app startup. Use a blind three-question run, finalize human labels, and verify saved results after restart. Include a Japanese fixture and an overflow fixture; judge usability and behavior without asserting general accuracy from a few samples.

## Validation and delivery sequence

1. Pin and inspect the Python contract; capture fixtures and verify strict overflow behavior.
2. Add shared provider types, registry, loopback configuration, health projection, local adapter, and safe errors.
3. Add schema 3 metadata and legacy decoding; validate migration/recovery before UI changes.
4. Add provider selection/readiness and saved-experiment restoration; reuse the evaluation workflow.
5. Document setup, add local smoke entry point, and complete acceptance checks.

Vitest covers URL validation and redirect rejection; key isolation; actor/provider pinning; shared execution gate; health/mismatch/errors; all three response types; missing usage; structured inputs; overflow handling; normalization/raw preservation; migration from populated schema 2; immutable legacy bodies/revisions; backup restore; repeated startup; and future-format rejection. Evaluation routes and regrading must make zero provider calls.

Playwright with mocked providers covers explicit selection, local use without a Jev key, unavailable server errors preserving edits, provider restoration, no fallback, form/JSON synchronization, blind execute → label → finalize → grade, profile switching during inference, and reload/restart-compatible history. Keep automated tests independent of model downloads and credentials.

Run `npm run check`, `npm run format:check`, and `npm run test:e2e`. Once the Python server is explicitly prepared, run local acceptance and report device, runtime revision, model identification limits, cold/warm timings, and measured memory. Preserve Jev compatibility with fixtures; paid Jev checks require an explicit request. Update README and AGENTS.md. No commit, push, or deployment of this planned feature is implied.

## Implementation status

HTTP adapter, selection, additive schema 3 metadata, raw-response isolation, and local smoke workflow are implemented. Wire fixtures are mocks derived from inspected official source, not live model captures. The user subsequently prepared a server on port 8012. A Japanese three-question run was saved blind, finalized, displayed, and reloaded. Structured state/instructions were accepted, but some structured/null criteria were rejected with 422 by the installed runtime. Its exact source revision and strict-window operation remain unverified. Source inspected: `75c9fd32e664954cdc18481434018aa507eee8fb`. Score levels are string-only and Choice requires at least two options in that runtime. The request model field is ignored upstream; the adapter checks configured and served names explicitly.

Build, 31 automated tests (including a recorded live response), and 9 browser tests pass. Local acceptance uses the user server on 8012; README records the measured limits. No cloud calls were made during validation. Commit, push, and merge were subsequently authorized.

### Installed runtime clarification

The prepared Python environment uses PyPI `strands-decider 0.1.0`. Its installed CLI help lacks `--strict-window` and its inference source contains truncation. The UI no longer instructs users to pass that flag unconditionally. Keep short-query trial support; strict long-input acceptance requires a separately verified runtime upgrade. The inspected source revision has the option, but it has not been installed or executed here. README separates both setup paths.
