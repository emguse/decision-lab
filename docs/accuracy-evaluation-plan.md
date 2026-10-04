# Accuracy Evaluation Implementation Plan

## Goal and delivery order

First establish local user identity and versioned, non-destructive persistence migrations. Then add blind human labeling and grading of a saved single-query run, without another provider call. The standard workflow is Playground question construction → execute with answers hidden → save the run automatically → blind labeling in Evaluation → finalize labels → reveal and grade. A single state with 40 questions evaluates those 40 judgments on that state, not generalization across 40 independent inputs.

The second delivery adds multiple labeled input cases and batch execution. Preserve the existing visible-answer Playground workflow as an explicitly selected alternative. Initial provider is Jev; local Clef, image input, model comparisons, AI-generated labels, CSV import, and calibration charts are deferred.

## Local identity and compatibility foundation

Local users are stable UUIDs with display names; they are attribution identities, not authenticated accounts. Create one default local user, allow adding/selecting users, and persist the selected identity in the browser. Do not support deletion or account merging in the first delivery. Duplicate display names do not imply the same identity. Validate a supplied user ID against persisted users; use the default for legacy requests that omit it. UI copy explicitly states that profile selection provides no access control.

Playground records `createdByUserId` on experiments and `executedByUserId` on runs. Evaluation drafts/revisions belong to `(runId, evaluatorUserId)`, and model-response exposure is recorded separately for each evaluator. All tabs/workspaces use the same selected local identity. On profile switch, save dirty annotation drafts under the previous identity before switching, clear answer caches and result views, and fetch the new identity's safe projections. Pin the actor at request start so switching during a request cannot reattribute its result. A revealed result from a prior profile must not render after switching. Follow-up work may add authenticated identities mapped to these stable user IDs.

Keep individual labels and revisions separate from an adopted reference-label revision. Independent labeling hides other evaluators' labels as well as model answers. The UI may show progress counts only. Compare evaluators only after all assigned evaluators finalize; adding an evaluator re-closes comparison until that evaluator finishes. Disagreement review does not silently overwrite anyone's labels. Adoption is explicit, stored as a separate immutable reference revision with its author and source revisions. Grading uses the chosen individual or adopted revision and names it. Deliberate profile switching can bypass these controls; this is a cooperative local workflow, not authentication.

Existing ownership cannot be reliably reconstructed: preserve current JSON bodies and attach legacy records to a reserved legacy identity labeled “Legacy / creator unknown”, rather than claiming the default user created them. Pre-migration exposure history is unknown for every evaluator and remains potentially exposed. For new blind runs, another evaluator's reveal does not reveal answers for the selected evaluator. Sharing observations outside the app cannot be measured; record provenance rather than asserting absence of bias.

Manage database schema revisions with `PRAGMA user_version`. Treat the present unversioned store as version 0; migration 1 creates identity/attribution infrastructure, and migration 2 adds evaluator assignments, drafts, revisions, exposure, and reference-label adoption. Apply ordered migrations in transactions before accepting requests; commit the version change with its migration. Enable foreign-key enforcement and keep migrations immutable once released. Retain the existing run/experiment JSON payloads; store attribution in additive metadata tables to avoid rewriting every payload. New databases apply the same migration chain. Refuse to open a database newer than the application's supported schema, with an actionable upgrade/restore message; never guess or silently downgrade.

Before the first pending migration, create a consistent SQLite backup using SQLite's backup facility (including committed WAL content); refuse migration if backup creation fails. Record the backup path and schema versions without private record contents. On migration failure, roll back, stop startup, and leave the original data recoverable. Document restoration with the application stopped. Prefer additive changes; any later destructive migration requires a separately reviewed conversion and recovery plan.

Keep database schema version, application release version, and record-format version distinct. Pin legacy payload decoding as format v1; future record-format changes need explicit converters and fixtures. A package version bump alone does not migrate SQLite. Deliver the identity/migration foundation separately from blind evaluation so compatibility can be verified in isolation.

## Blind labeling and exposure policy

Blind execution is a selectable Playground mode enabled by default for new experiments. Before executing, the UI explains that answers will be hidden until labels are finalized. The server saves the complete response but returns only the run ID, input/question snapshot, and annotation status. Show input, question instructions, criterion descriptions, and human label controls. Do not show model answers, probabilities, confidence, response JSON, correctness, answer-dependent sorting/highlights, or aggregate results during annotation. Do not prefill labels from predictions; every label starts unset.

Use a dedicated answer-free labeling API projection. Do not load the ordinary full-response history endpoint in blind mode. Provide an answer-free history list for navigation; an existing visible-response cache/result must not render in the annotation workspace. These controls prevent accidental disclosure through the application; they are not an authorization boundary against a local user inspecting SQLite or deliberately calling legacy endpoints.

A user can save incomplete label drafts and reopen them. “Finalize labels and reveal results” requires valid labels for every question, creates an immutable label revision, and marks the response revealed for that evaluator. Stop treating that revision's subsequent edits as blind: create a separate, explicitly post-reveal revision while retaining the original labels and scores. Do not permit resetting a revealed evaluator/run pair to an unexposed state.

For existing runs, or visible-answer executions, mark labeling as potentially exposed from the outset. Track when the app explicitly returns a full result, including the reveal action. Existing runs with unknown exposure history are conservatively classified as potentially exposed. Include this provenance in evaluation results. Hiding a previously viewed answer cannot undo the user's memory; do not claim genuinely blind labeling for those runs. Human-provided labels are reference judgments, not guarantees of objective correctness.

An early reveal is possible only through an explicit “Reveal before labeling” action explaining the effect; it permanently marks subsequent annotation as potentially exposed. Threshold changes and grading settings do not expose results before labels are finalized.

## Labels, scoring, and first-delivery UI

Annotations attach to an immutable saved run, not the mutable experiment definition. Labels are keyed by question ID: boolean for Noul, criterion key for Choice, integer rubric index for Score. Validate all labels against the run snapshot. Use unselected Yes/No radio controls, a Choice select with an unset placeholder, and a Score-level select with an unset placeholder. Show question-by-question progress and an optional human note; no JSON editing is needed for labels.

After reveal, display expected/predicted values and per-question errors:

- Noul: predict true when `noul >= threshold`; default 0.5. Show correct/incorrect and P(Yes).
- Choice: compare the returned `choice` with the reference key.
- Score: show absolute error using the continuous score without rounding. Pass when error is at most tolerance; default 0.5 rubric levels.
- Summary: correct/total Noul and Choice counts, Score MAE/pass count, and all-question pass count. Keep question types separate rather than averaging incompatible metrics. Zero-count metrics display as unavailable.

Regrade stored raw answers locally when threshold or tolerance changes, with no provider requests. Retain original grading settings and label adjusted views explicitly. Confidence describes concentration, not correctness. Allow filtering incorrect judgments only after reveal. From a result, copy the input/questions into Playground for follow-up experimentation without automatic execution.

Extract shared question/result presentation components from the current UI. Keep the first-delivery annotation workspace focused on the saved state, a question list, label controls, draft save, and finalization. Provide a history of evaluations and the label exposure status.

## First-delivery persistence and interfaces

Add SQLite annotation records and immutable finalized revisions via an idempotent migration; preserve current runs/experiments. Add per-evaluator/per-run exposure state, with legacy runs defaulting to unknown/potentially exposed. Implement direct run lookup rather than searching the latest-100 list.

Use Zod-validated interfaces. Add `GET/POST /api/local-users`; accept explicit local actor IDs on creation/annotation operations and safe-read requests. This is attribution, not authorization. Validate assignment and revision membership before comparison/adoption. Add evaluator-assignment and explicit reference-adoption routes alongside the following run routes:

- Extend `POST /api/runs` with an optional blind flag. For blind runs, persist normally and return only the answer-free projection; retain compatibility for visible-answer requests.
- `GET /api/runs/summaries`: list answer-free IDs, titles, dates, and annotation/exposure status.
- `GET /api/runs/:id/labeling`: return input/questions, draft labels, and exposure provenance, never model answers.
- `PUT /api/runs/:id/labels`: save an incomplete validated draft without grading feedback.
- `POST /api/runs/:id/finalize`: validate completeness, atomically persist a label revision and reveal state, then return results.
- `POST /api/runs/:id/reveal`: explicitly reveal early and record exposure.
- `GET /api/runs/:id/evaluation`: return predictions/metrics only for the selected evaluator’s revealed runs; reject access before their reveal.

Guard legacy full-response reads from accidental use in blind mode and record exposure when full responses are accessed. Maintain server-side keys, loopback restrictions, origin checks, safe errors, and body limits. Annotation and regrading endpoints never call the provider.

## Second delivery: multiple-case evaluation

An evaluation set contains a model, shared questions, 1–100 cases, grading settings, and reference labels. Each case has stable ID/title/state and labels. Start with manually labeled cases; changing question IDs/types or criteria invalidates incompatible labels explicitly. Keep development cases distinct from held-out cases rather than claiming tuning-set scores measure generalization.

Execute one request per case, batching all its questions, with a sequential server-side runner and a shared execution gate for Playground and evaluations. Persist the complete definition/label snapshot before execution and each outcome immediately. Jobs continue independently of the browser, support one-second progress polling, and stop after the in-flight case finishes. No automatic retries. Authentication/configuration failure stops the job; other case failures are stored separately and execution continues. Server restart marks unfinished jobs interrupted, with no automatic resending.

Add SQLite evaluation sets/jobs/case attempts and typed CRUD/start/status/stop/retry-failed endpoints. Explicit retry creates a child job containing only failed or unfinished cases, never resending successes; show subset coverage. Store requested and resolved model versions and flag mixed resolved versions. Costs/usage are based on returned token counts; unknown totals remain visibly partial.

Report per-question accuracy, Noul TP/TN/FP/FN and precision/recall, Choice confusion matrices (expected rows, predicted columns), Score MAE/pass rate, and all-question case pass rate. API failures are ungraded and separately counted; scoring denominators and grading coverage are always visible. Never show an empty aggregate as zero or 100% accuracy.

## Validation and implementation sequence

1. Versioned migrations, consistent backup/recovery, local users, Playground attribution, and safe profile switching.
2. Shared label schemas, pure graders, and per-evaluator exposure/revision state transitions.
3. SQLite migration, immutable revisions, run lookup, answer-free projections, and reveal/finalize APIs.
4. Playground blind execution, annotation UI, answer-free history, and post-reveal results/regrading.
5. First-delivery checks and documentation, then multiple-case runner/storage/UI as a subsequent change.

Vitest: fresh and populated v0 migration fixtures, byte-equivalent legacy JSON preservation, backup restore, repeated startup, migration rollback, unsupported future schema refusal, foreign-key integrity, actor pinning, isolated evaluator drafts/exposure, immutable adoption provenance, and unset/invalid labels, threshold equality, Score tolerance boundaries, zero denominators, draft persistence, immutable revisions, legacy exposure handling, incomplete-finalize rejection, atomic finalization, and no grading/provider calls before reveal. Verify answer-free responses contain no predictions, raw response, confidence, probabilities, or answer-derived feedback.

Playwright with mocked provider: local user switching with dirty drafts and an in-flight request, creator/executor attribution, no previous-user answer cache leakage, two independent evaluator drafts, one evaluator revealing without exposing another, comparison/adoption gating, and blind execute → label → finalize → reveal; no answer/probability in DOM or network responses before finalization; reload preserves drafts and blindness; ordinary cached results do not leak into annotation; early reveal and post-reveal edits remain marked exposed; regrading makes zero provider calls. Verify visible-answer Playground compatibility and saved history after restart.

Second-delivery tests cover migration preservation, snapshots, incompatible labels, per-case persistence, duplicate starts, shared execution gate, stop, interrupted recovery, error handling, and retry selection.

Run `npm run check`, `npm run format:check`, and `npm run test:e2e`. First-delivery acceptance can use existing saved real runs (marked potentially exposed) without paid calls. New live blind execution is performed only when explicitly requested. Update README and AGENTS.md with workflows and limitations. Implementation is authorized for the first delivery. Commit, deployment, and push require a separate request.

## Implementation status

First delivery is implemented: local profiles and attribution, schema 1/2 migrations with consistent backup, per-evaluator blind drafts/revisions, explicit reveal, grading, comparison, and immutable reference adoption. Build and 22 Vitest tests pass; all 6 Playwright tests pass with a mocked provider. No paid provider calls were made during acceptance testing. Multiple-case datasets and the batch runner remain the second delivery.
