# User guide

Decision Lab is a local app for evaluating typed model judgments from input and questions. It does not generate prose or execute the route selected by a model. For setup and provider preparation, see [Operations and development](operations.md) and [Connection settings](connections.md).

## Workspaces

| Workspace | Purpose | Next step |
| --- | --- | --- |
| Playground | Edit and try one input with typed questions | Evaluate the saved run in Evaluation |
| Suites | Import multiple cases and run them sequentially | Evaluate each case, then return to the same execution |
| Evaluation | Label saved answers and compare references | Return to the suite to summarize and export, or copy input to Playground |
| Help | Read the instructions and specification | Select Back to work to return to your workspace |

**Saved experiments** in the sidebar are editable Playground inputs. **Run history** opens saved executions in Evaluation. Open Suites to browse experiment suites and their executions. Help displays the same Markdown documents bundled from this repository.

The app interface is in English. Experiment input, question descriptions, notes, and user names can use any supported language. Importing or exporting data does not translate it.

## Try a single input

1. In Playground, choose an experiment name, connection, model, and input. Input can be text or JSON.
2. Add questions. Noul is a Yes/No judgment, Choice selects an option ID, and Score rates an ordered set of levels. Choice option IDs must be unique; Score levels must have a meaningful order.
3. Edit structured descriptions in JSON mode. Fix invalid drafts before saving or executing.
4. **Save experiment** saves editable input without inference. **Run decision** saves an immutable input and response snapshot.
5. Open the run in Evaluation from Run history. Use **Copy input and questions to Playground** to reuse its input.

Confidence describes distribution concentration, not correctness. Score is the probability-weighted rubric position. Usage is unavailable when a provider does not return token counts.

## Create an experiment suite with an LLM

Experiment Suites accept text/JSON in schema 1 and ordered local original images in schema 2. Use **Case images** to save a new version. Playground and Flows also support images through compatible local connections. Portable image bundles remain deferred.

1. Give a user-supplied LLM the [Exchange specification](experiment-exchange.md) and input examples. Ask it to produce a Decision Definition and Experiment Suite as separate files. The definition contains questions; the suite contains input cases and optional expectations. Decision Lab does not include an LLM authoring service.
2. In the suite list, select input files or paste their contents. **Validate and preview** checks them; **Save input** imports them. Neither action calls a model.
3. In suite details, choose a connection and model, then select **Run suite sequentially**. Execution stops on the first failure. **Resume unfinished cases** skips successful cases and retries unfinished cases. Create a new execution for a separate comparison.
4. Select an execution and open each case with **Open blind evaluation**. After evaluation, select **Back to suite execution** to return to that same execution.
5. As the current user, finalize labels or explicitly reveal answers for every successful case. Full result export remains unavailable while any successful case is hidden from that user.
6. Select a **Grading source**: imported expectations, your latest finalized labels, or the latest adopted reference. Summarize or export YAML/JSON results. Return the results and input to your LLM and assign a new content version to improved definitions or suites.

Use the [definition YAML example](../examples/exchange/decision-definition.yaml) and [suite YAML example](../examples/exchange/experiment-suite.yaml). These examples include Japanese experiment input; that is data, not interface text. The [result example](../examples/exchange/experiment-results.yaml) is an illustrative fixture, not a live evaluation. Results import is not supported.

## Evaluate without seeing answers

New Playground runs default to blind execution; successful suite cases are also saved blind. Evaluation labels start unset. You can save an incomplete draft. Finalizing all question labels reveals answers and grading. Viewing answers first requires an explicit reveal action.

Assign other local users as evaluators to maintain independent labels and exposure histories. Comparison becomes available after all assigned evaluators finalize. Adopted reference labels are saved as a separate revision. Edits after reveal retain earlier revisions. Leaving Evaluation or switching users saves dirty labels first; a failed save prevents navigation and displays the error.

Imported expectations are separate from human labels. They never enter model input or label drafts. Importing a suite with expectations, exporting its complete input, or viewing an unlocked reference comparison records reference familiarity. A user can know expectations without having seen model answers. Local users provide attribution, not authentication. The app cannot hide answers or references remembered outside it.

## Read the metrics

Noul is graded using P(Yes) against a threshold; Choice compares exact option IDs. Score uses unrounded absolute error and a tolerance, and also reports MAE. Both the default threshold and tolerance are 0.5. Changing grading settings regrades saved answers without inference.

Questions without labels in the selected grading source remain ungraded. There is no automatic fallback to another source. Missing labels and failed or unfinished cases are counted separately and excluded from accuracy denominators. Human references are judgments, not a guarantee of objective truth.

## Troubleshooting

- For missing configuration or model mismatch, check [Connection settings](connections.md).
- Failed suite executions retain successful cases. After a timeout, check the inference service before resuming. Retrying makes a new request and may incur provider fees.
- Cases running when the server restarts are marked interrupted; they are not automatically resent.
- Different content under the same name and content version causes a conflict. Assign a new version to modified input.
- For data recovery, follow the backup procedure in [Operations and development](operations.md).

## Image inputs

In Playground, select, drop, or paste images into the **Images** area. Up to four static PNG, JPEG, or WebP files are accepted, each at most 5 MiB and 4096 px per side. GIF, animated images, SVG, and image URLs are unsupported. Move images left/right to set their order, or remove an attachment. Upload status and errors are shown; execution and Experiment saving wait for uploads to finish. Dismiss a failed upload after reviewing it; already uploaded images remain attached.

Select a ready Strands or direct llama.cpp connection whose health reports `vision: true` and the configured model. Other connections retain attachments but cannot execute them. Refresh connection health after restarting the runtime. Strands requires `--vision` and scales the longer side to 448 px for inference. Clef requires a compatible image model and loaded `--mmproj`; its full prompt, including images and all questions, must fit in `--ubatch-size`. Router image inference is unsupported. Original images are retained. Text/JSON state can accompany images, or be an empty string.

For a llama.cpp connection, **Build a request → Model** displays the runtime-reported model identity. The accompanying artifact and repository revision describe the identity recorded with each new run. **Request model ID / alias** is shown separately and remains the `model` value sent in Request JSON. Missing identity is explicitly shown as unknown; a mismatched request ID does not inherit the connected model's identity. Identity is rechecked at execution, and the saved run snapshot is authoritative.

When **Run decision** is disabled, **Run unavailable** below the button lists the current blocking reasons and how to resolve them. Image diagnostics distinguish router mode (an application restriction), missing or false Strands vision capability, unverified connection health, unsupported image input, and model mismatch. Upload errors, invalid JSON/form fields, missing experiment name, and missing connection configuration are also explained. Connection verification alone does not imply that image runs are allowed.

The JSON editor uses `imageIds: ["<uploaded UUID>"]`, not Base64 or URLs. IDs are local database references, not portable exchange data. Experiment saving, history, copying a saved run to Playground, and human evaluation retain images in their original order. Viewing an input image does not reveal model predictions. Profile switching discards pending UI updates from the prior profile. The application shares local input data; profiles provide attribution rather than authentication.

Image-enabled Suite cases and portable image import/export are deferred. Existing text-only Suite and exchange workflows are unchanged.

## Decision flows and image Suites

Open **Flows** to connect Input, Judgment and Final result cards. Start with **Load example flow**, configure ordered branches and a required default in the inspector, save a version, select one connection and run. Finalize human labels before revealing to preserve blindness. The revealed graph highlights the execution path and shows each answer and selected condition. Flow Suites evaluate final outcomes, optional intermediate judgments and paths, with domain and calibration metrics. See [Decision flows](decision-flows.md).

In existing Suites, **Case images** attaches ordered local originals and saves a new schema-2 version. Unexecuted saved Suites retain the originals. Exports contain local references; portable bundles with image bytes remain a later extension. Image-incompatible connections fail explicitly.
