# Exchange specification v1

For workflow instructions, see the [User guide](user-guide.md). For provider preparation and recovery, see [Connection settings](connections.md) and [Operations and development](operations.md). This document defines the file and API contracts.

## Files and versions

Each file contains exactly one JSON-compatible document. YAML 1.2 and JSON use the
same Zod schemas in `shared/exchange.ts`. `kind` distinguishes the three documents;
`schemaVersion: 1` is the exchange contract version. Definition/Suite `version`
is a positive integer assigned by the author. Application release, SQLite schema,
persisted execution `formatVersion`, and exchange/content versions are independent.

- [`decision-definition.yaml`](../examples/exchange/decision-definition.yaml)
  defines `name`, `version`, and `questions`. Each question uses the existing
  `{type, instructions, criteria?}` format. Choice criteria are an option-ID map,
  Noul criteria optionally describe `true`/`false`, and Score criteria are an ordered
  array of 2–10 levels. Instructions/descriptions accept strings, JSON objects, or
  arrays; Choice descriptions may also be `null`. No provider/model is embedded.
- [`experiment-suite.yaml`](../examples/exchange/experiment-suite.yaml)
  defines `name`, `version`, an exact `definition: {name, version}` reference,
  `cases: [{id, state, expected?, note?}]`, and optional `settings`.
  `expected` maps question IDs to booleans for Noul, option IDs for Choice, and
  zero-based integer rubric levels for Score. Omitted/partial expected labels are
  allowed. `settings` defaults to `{threshold: 0.5, tolerance: 0.5}`.
- [`experiment-results.yaml`](../examples/exchange/experiment-results.yaml)
  is an **illustrative fixture, not a live model result**. Results contain immutable
  definition/Suite snapshots, execution attribution/provider/model/time/interaction,
  case attempts, actual `input`, normalized `response` and usage, run metadata,
  `grading`, model exposure, expected-reference exposure, and aggregate metrics.
  Unknown artifact revisions are `null`; an alias is not evidence of a checkpoint
  version. Matching `.json` examples are provided for all three documents.

**LLM authoring instructions:** preserve question IDs, option IDs, structured
instructions, and array order. Supply explicit content versions and complete
criteria. Keep background in `state` and reference labels in `expected`; do not
put expectations into model state. Produce two separate files and change a
content version when modifying an already imported file. To improve an experiment,
inspect the exported per-question errors and probabilities, then propose a new
version of the definition and/or Suite. Missing labels and failed cases are not
correct answers and are not included in accuracy denominators.

Import/export preserves values, types, and order after schema validation/defaults.
It does not preserve comments, quoting, indentation, or original bytes. Object
property order follows JavaScript's rules (integer-like keys enumerate numerically);
use descriptive IDs if candidate order matters. These files accept no executable
code, images, templates, custom YAML tags, anchors, aliases, merge semantics,
non-finite numbers, or duplicate mapping keys. Mapping keys must be strings; quote
boolean-like/numeric keys in YAML. Prototype-related keys (`__proto__`,
`constructor`, `prototype`) are unsupported. Identifiers must have no surrounding
whitespace; they are rejected rather than silently trimmed. Unknown fields and future exchange
versions are rejected. Inputs are limited to 1 MiB per file, 100 cases per Suite,
and 64 nested JSON levels. The API also limits the complete JSON request to 1 MiB,
so source escaping and two-file import requests must fit within that total.

## Import, execution, and recovery

The UI accepts file upload and paste. A preview validates every supplied document
without saving or calling a provider. Save validates again and atomically imports
one or two documents. An exact duplicate is idempotent; different content under
the same kind/name/version returns a conflict. Referenced definitions must already
exist or be included in the same import. Original single-query Playground
Experiments remain available and are not converted to Suites.

Choose a provider and its model explicitly before starting. Each case sends only
`{model, state, questions}` through the existing DecisionProvider. All questions
remain together, in their saved order; Clef's configured joint interaction is
preserved. No semantic conversion of unsupported criteria or automatic provider
fallback is performed. Each successful run is saved blind and linked to its case
in the same transaction. Another Suite or Playground inference cannot start
while a Suite is executing.

The server executes sequentially and returns progress immediately. The first
failure stops the Suite; completed cases stay saved. **Resume** is an explicit
operation by the original execution user, retrying failed/interrupted/pending
cases, retaining every attempt and skipping successful cases. Restart marks
persisted running attempts interrupted; it does not automatically issue model
requests. Input snapshots and the provider/model remain fixed. Changed configured
connections or local origin/model require starting a new execution. Check upstream
state before retrying timeouts or interruptions: a provider may have completed a
request even when no response was saved. Exactly-once remote inference is not
promised. Each explicit new execution/retry can incur provider fees.

SQLite migration 4 adds documents, Suite executions, run links, and reference
exposure records. Store.open backs up earlier persistent schemas before migration;
released migrations and old payloads are unchanged. Restore the pre-migration
backup to roll back; older releases refuse schema 4. No real credentials are
required by automated tests.

## Blind evaluation and reference provenance

Imported expectations are independent external reference values, not human label
revisions. They never seed label drafts, finalize a label, adopt a reference, or
reach the provider. Suite detail/progress and blind labeling responses contain no
expectations, predictions, original local responses, or correctness metrics.
Finalizing one's complete labels or explicitly revealing a case unlocks its
model answers and imported reference comparison for that evaluator only. Other
users remain blind. The existing all-assigned-evaluators-finalized condition still
controls human comparison and reference adoption.

Importing a Suite with expectations, exporting its complete input, or receiving
an unlocked reference/result records expected-reference familiarity per local
user **at Suite level**. Label revisions snapshot that familiarity separately
from model exposure. Import authors have already seen their own input; hiding the
reference in the labeling UI does not undo that knowledge. A finalized label can
be model-blind and still expectation-informed. Merely pasting an external file
without saving is not observable as an import by the server; knowledge outside
the app cannot be tracked. Local identities are attribution, not authentication,
and do not defend against deliberately inspecting local files or impersonation.

## Results and grading

Stop or complete execution, then finalize or explicitly reveal **every successful
case as the exporting user**. Otherwise the full result endpoint refuses the
request with 403; running executions return 409. Failed and unexecuted cases remain
in the result with statuses and attempts. Exporting does not implicitly reveal
model outputs or call providers.

Choose `expected`, `individual` (the user's latest finalized revision), or
`reference` (latest adopted revision, gated by existing comparison rules).
There is no automatic fallback if the chosen source is absent: those questions
remain ungraded. Actual selected revision IDs, source-revision IDs, labels, and
settings are embedded. Top-level `gradingSelection` records the chosen source and
settings override even when every case is ungraded. A settings override explicitly regrades saved answers;
otherwise imported labels use Suite settings and human labels use their selected
revision settings. Human references are judgments, not objective truth.

Metrics count only labeled questions on successful cases. Noul uses `P(Yes) >=
threshold`; Choice compares exact option IDs; Score uses unrounded absolute error
and `error <= tolerance`. Noul/Choice accuracy and Score MAE remain separate;
zero denominators produce `null`. Missing labels on successes and failed/
interrupted/pending case counts are reported separately. Local raw responses stay
in their existing separate persistence table; exported outputs are normalized.
Results import and cross-provider comparison dashboards are deferred.

## HTTP interface

All endpoints retain the loopback origin checks and `X-Local-User` attribution.
The UI exports through JSON envelopes so file responses remain easy to mock.

| Endpoint | Behavior |
| --- | --- |
| `GET /api/exchange/documents` | Metadata only; no reference values |
| `POST /api/exchange/preview` | `{documents: [{source, format: "yaml"\|"json"}]}` → document summaries |
| `POST /api/exchange/import` | Same payload → saved document metadata, 201 |
| `POST /api/exchange/documents/:id/export` | `{format}` → `{text, format, filename}`; records reference familiarity |
| `GET /api/suites/:id` | Input states without expected/note values, familiarity, and execution progress |
| `POST /api/suites/:id/execute` | `{provider, model}` → initial progress, 202 |
| `GET /api/suite-executions/:id` | Per-user progress without predictions/labels |
| `POST /api/suite-executions/:id/resume` | `{}` → initial progress, 202 |
| `GET /api/runs/:id/suite-reference` | Unlocked imported expectations/settings/note, or null for an ordinary run |
| `POST /api/suite-executions/:id/results` | `{source, settings?}` → validated `experiment-results` document |
| `POST /api/suite-executions/:id/export` | `{source, settings?, format}` → `{text, format, filename}` |

Provider/API contracts remain as documented by the
[official System One API](https://docs.typesafe.ai/api) and
[structured-description guidance](https://docs.typesafe.ai/primitives/advanced).
YAML parsing/serialization uses the [yaml package](https://eemeli.org/yaml/).
