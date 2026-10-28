# Decision flows

Flows connects input, judgment and final-result cards. A judgment pins an existing
Definition by name and version. Branches are evaluated from top to bottom; all
conditions within a branch must match. The first matching branch wins, otherwise
the required default connection is used. Choice values, Noul probability,
inclusive Score ranges and Choice/Score confidence are available in forms.
No application code is needed for routing.

## Build and try

1. Open **Flows**, then **Load example flow**, or import your existing Definitions
   in Suites and add judgment cards. Drag cards by their headers. Use **Connect**
   and click a destination for the default connection; configure conditional
   destinations in the inspector.
2. Set result IDs and descriptions, then save a named integer version. Changes
   require a new version. All cards must be reachable; cycles, missing references,
   invalid condition types/options/ranges and broken destinations prevent saving.
3. Select one model connection for the entire execution, enter text or JSON and
   optionally upload ordered original images. Run the saved flow.
4. Supply your expected final result, optional connected path and intermediate
   labels before **Finalize labels and reveal**. Alternatively reveal explicitly.
   Revealed traces highlight the actual path and show each query, answer, branch
   index (zero-based; null means default), destination and metadata.
5. Assign local evaluators and adopt a reference only after all assigned evaluators
   finalize. Adoption names the exact latest revisions. Changing a label creates
   another immutable revision rather than replacing the reference history.

Example labels are synthetic demonstrations, not evidence of model accuracy.
Human intermediate labels use the existing question label types (boolean, Choice
string or numeric Score). The optional advanced label form accepts JSON keyed by
judgment card ID; branch construction itself uses forms.

## Execution contract

Each request receives `state: { input: ORIGINAL_STATE, decisions: COMPLETED_ANSWERS }`.
`decisions` is keyed by card ID and contains only the answers completed on the
actual path. The same ordered original image IDs are resolved by the existing
adapter for each judgment. Untaken judgments are never inferred. Expected Suite
labels are never appended to provider input. Authors must keep their own input
free of ground-truth labels if they want a meaningful blind evaluation.

Definition snapshots, the flow snapshot, connection fingerprint, model and
metadata, original input, actual queries/answers, branches, path and final result
are retained. Original local responses are stored separately. The provider must
pass the existing health/model/image capability checks; images are never silently
removed. Execution records containing images use format 2, others format 1.

One inference worker is shared with Playground and Suites. Graph execution is
serial and follows exactly one successor. A provider failure has no business
result: it is recorded as `failed`, distinct from a configured `review` result.
Restart changes unfinished executions to `interrupted`; create a fresh execution
to retry. Flow Suites continue to other cases after a failed case.

Blind history contains status and attribution, without answers, actual path,
result or raw provider output. Evaluator-specific reveal and immutable labels
preserve the existing blindness boundary. Importing/exporting expected labels
records expectation familiarity separately from model exposure. Local profiles
are attribution, not authentication.

## Suites and images

Existing decision Suites retain schema 1 for text/JSON. **Case images** creates a
new schema-2 Suite version with ordered local image IDs. Uploading and saving a
Suite retains original deduplicated SQLite BLOBs even before execution. Schema 1
rejects image references. JSON/YAML exports contain references to the same local
database, not image bytes; portable image bundles remain a subsequent extension.

A `flow-suite` has schema 1 and pins a flow name/version. Every case has original
state, optional ordered image IDs, `tuning` or `evaluation` partition, provenance,
and an optional expected result/path/intermediate judgments. Build cases in the
form or import JSON/YAML. Saved Suites are read-only until **Edit new version with
expectations** explicitly loads the expected labels and marks familiarity.

Use provenance to retain source, immutable upstream revision, original case ID,
license, transform version, language, domain, evidence group and label origin.
Form-created original cases receive unique source-case and evidence-group IDs,
independent of their position in a Suite. Editing a new version retains these
IDs. Set a shared evidence group explicitly when creating related variants.
All variants of the same photograph must share an evidence group and partition.
Saving rejects a source/revision/evidence group used in both partitions across
saved Suites. This requires correct provenance: arbitrary new source identities
cannot automatically be recognized as the same photograph. Use separate Suites
for threshold tuning and final evaluation, and freeze routing before final runs.

Choose exactly one execution per case. Results require each selected execution to
be revealed. Select imported expectations, your finalized labels or adopted
reference labels; missing labels remain missing and are never silently replaced.
The result export contains snapshots, selected label revisions, settings and grades.

- Judgment grades identify incorrect or unexecuted expected questions.
- Path and final-result grades compare actual output with case expectations.
- Routing grades apply gold intermediate labels to the configured conditions and
  compare their destination with the expected path. This detects rule mismatches
  independently of model answers. Missing gold inputs or confidence-dependent
  rules may be ungradable; no gold confidence is invented.
- Noul uses scalar Brier; Choice uses the sum of multiclass squared probability
  errors. Ten fixed confidence bins give separate top-label ECE estimates. Score
  uses MAE. Macro-F1 is per card/question over observed expected/predicted classes.
- Coverage/risk uses minimum reported confidence over questions referenced by
  considered branches (Noul uses `abs(2p-1)`). It is a gating statistic, not the
  probability that the whole workflow is correct. Failed labeled cases reduce
  coverage and count as incorrect final results.
- Domain/language/partition slices, missing-label/failure counts and serial
  inference p50/p95 are included. Costs remain unknown. Overall metrics aggregate
  selected cases; use separate Suites to keep tuning and final reporting apart.
- Variant groups compare final results within source/revision/partition/connection/model. Mark
  original, paraphrase or option-order provenance; these variants are authored,
  not automatically generated. Option-order variants require versioned Definitions
  and flows. Stability does not establish correctness. To compare an option-order Definition
  version with its baseline, export revealed results from each version's Suite,
  retain the same variant group and evidence group, and run:

```sh
npm run compare:flows -- --output /path/comparison.json /path/base-results.json /path/variant-results.json
```

The comparison retains execution snapshots and label sources, rejects duplicate
executions and partition leakage, and recomputes grades/metrics without inference.
Use the same connection and model for perturbation comparisons. Connection/model
identities separate stability groups; mix domains or partitions only when you
intend the aggregate, and inspect the provided slices.

## Public benchmark preparation

[Decision Index](https://huggingface.co/spaces/multimodalart/jev-decision-index)
informs domain comparison, confidence and perturbation evaluation. This application
does not reproduce its leaderboard or claim compatible benchmark scores.

`npm run prepare:benchmark -- ...` prepares Definition, flow and Suite JSON from
local upstream CSV files. It does not download data or perform inference. Seeded
sampling defaults to 30 cases; versions, source revision and original split are
explicit. Choose a new output directory; existing artifacts are not overwritten.
Import `definition.json` in Suites, then `flow.json` and `suite.json` in Flows.

For [BANKING77](https://github.com/PolyAI-LDN/task-specific-datasets), use the
upstream `text,category` CSV and select 2–30 categories present in the file:

```sh
npm run prepare:benchmark -- --dataset banking77 --input /path/test.csv \
  --output /path/banking-evaluation --revision UPSTREAM_COMMIT --split test \
  --categories card_arrival,card_not_working --partition evaluation --seed 42 --limit 30
```

This bounded intent comparison is not the full 77-class benchmark. The source is
CC-BY-4.0; retain its attribution and cite Casanueva et al., *Efficient Intent
Detection with Dual Sentence Encoders* (2020). Evidence groups hash the trimmed
original utterance so identical source inputs cannot cross partitions unnoticed.
Result and destination IDs derive from category names, so reordering or expanding
`--categories` preserves each intent's identity. Choice options and branches retain
the supplied order. The `banking77-choice-v2` transform replaces positional result
IDs; regenerate both baseline and variants with new document versions when
comparing older prepared bundles. Existing saved documents and exports stay unchanged.

For [Open Images](https://storage.googleapis.com/openimages/web/factsfigures.html),
use human-verified image-level labels (`ImageID,LabelName,Confidence`). Only explicit
0/1 labels for the selected class are used; unlabeled objects are not negatives.
Upload local originals first and provide a manifest keyed by upstream ImageID:

```json
{"IMAGE_ID":{"imageIds":["LOCAL_IMAGE_UUID"],"sourceUrl":"https://original.example/photo",
"imageLicense":"CC-BY-2.0","licenseVerified":true}}
```

```sh
npm run prepare:benchmark -- --dataset open-images --input /path/verified-labels.csv \
  --images /path/manifest.json --label /m/UPSTREAM_LABEL --description "a cat" \
  --output /path/image-evaluation --revision UPSTREAM_RELEASE --split validation \
  --partition evaluation --seed 42 --limit 30
```

Annotation and individual image licenses are different. Verify each image's
original source/license and retain attribution; the manifest requires an explicit
verification flag. Do not substitute model-generated labels for source labels.
Prepared IDs must exist in the receiving application's database.

Keep public image-recognition Suites separate from Japanese photograph plus
business-state workflow Suites. Start the latter with tens of locally licensed
original photos and human-reviewed labels, including ambiguity/review outcomes;
record who created the labels through finalized revisions. The included two-case
support example only demonstrates the mechanics.

## Limits

No loops, parallel inference, external business operations, human-wait pauses or
per-card model switching. Maximum 50 cards, 30 branches per judgment and 100 cases
per Suite. Image transport restrictions remain those of the existing connections.
