# Connection settings

Restart Node/Hono after changing connections. For everyday use, see the [User guide](user-guide.md); for persistence and recovery, see [Operations and development](operations.md).

## Jev

For installation and startup, see [Operations and development](operations.md). To use Jev, configure the following key.

Set `TYPESAFE_API_KEY` in `.env` using your TypeSafe account's API key. Never paste keys into the frontend or commit them. Restart the server after changing the key.

## TOML connector configuration

Copy `systemone.example.toml` to `systemone.toml`, edit it, and restart Node/Hono.
Alternatively set `SYSTEMONE_CONFIG_PATH` to a file path (relative paths use the
process working directory). TOML is loaded once; there is no hot reload.

Set `version = 1` once at the top of the file. Each `[[connections]]` entry
provides an `id`, a display `label`, an `adapter`, an `endpoint`, and a default
`model`. Use `strands` for Strands Decider, `llamacpp` for Clef with llama.cpp,
and `systemone` for other services implementing the System One contract.
Registered connections appear in the connection selector. The local examples
below can be added to the same file; field constraints and compatibility notes
follow under [Details](#details).

## Local configuration examples

### Strands Decider

Prepare and start a Strands Decider service separately, following its
[official runtime documentation](https://github.com/strands-labs/strands-decider).
Decision Lab configures the connection; it does not install the runtime or select
its checkpoint. Add an entry matching the running service to `systemone.toml`:

```toml
[[connections]]
id = "strands-local"
label = "Local · Strands Decider"
adapter = "strands"
endpoint = "http://127.0.0.1:8000/v1/systemone"
model = "StrandsAgents/strands-decider-2B-qwen3.5-v1-2610"
timeout_ms = 60000
question_interaction = "independent"
```

The model above is an example from the
[published model card](https://huggingface.co/StrandsAgents/strands-decider-2B-qwen3.5-v1-2610),
not an application default. Set `model` to the checkpoint loaded by your service
and `endpoint` to its loopback address and port. Restart Node/Hono, select the
connection in Playground, and use **Check connection**. Multiple services can be
registered with different connection IDs. See [Strands adapter behavior](#strands-adapter-behavior)
for application constraints.

### Clef with llama.cpp v0.6.0

Install llama.cpp and obtain a compatible Clef GGUF separately, following upstream
instructions and the selected model's license. No model or runtime is bundled.
Start a text-only instance, replacing the model path and choosing a batch size that
fits your model/input and available memory:

```sh
llama-server --model /path/to/clef.gguf --alias clef --host 127.0.0.1 --port 8080 --ubatch-size 4096 --batch-size 4096
```

Add the connection to `systemone.toml`, then restart Node/Hono:

```toml
[[connections]]
id = "clef-local"
label = "Local · Clef (llama.cpp)"
adapter = "llamacpp"
endpoint = "http://127.0.0.1:8080/v1/systemone"
model = "clef"
timeout_ms = 60000
question_interaction = "joint"
```

The model alias and port must match the separately started server. Choose this connection in Playground after restarting Node/Hono. For readiness checks and router mode, see [Clef runtime and readiness](#clef-runtime-and-readiness).

## Details

### TOML fields and endpoint restrictions

Without a default file, Jev remains available when its key is configured;
no additional connections are registered.
An explicit missing file, unknown fields, duplicate IDs, the reserved ID `jev`,
or invalid values prevent startup. Config errors omit source lines and endpoints.

Each `[[connections]]` defines `id` (lowercase letters/digits/hyphens, starting with
a letter, at most 64 characters), `label`, `adapter` (`llamacpp`, `systemone`, or `strands`),
`endpoint` (the complete POST URL), and default `model`. Optional `timeout_ms`
defaults to 60000 (range 100–600000). For `llamacpp`/`systemone`, optional `api_key_env` names a server-side
Bearer key environment variable; never put keys directly in TOML. Keys are never
inherited from Jev. Missing required credentials leave the connection unconfigured.
`question_interaction` is `independent`, `joint`, or `unknown` (default for `llamacpp`/`systemone`, while `strands` defaults to and requires `independent`); this is
operator-supplied metadata, not a discovered model property. Use `joint` for Clef.
Local HTTP requires an explicit `127.0.0.1` or `[::1]` origin and `/v1/systemone`.
Other services require HTTPS. Redirects, embedded URL credentials, query strings,
and fragments are rejected. Never reference `TYPESAFE_API_KEY` for a local service.
HTTPS services must implement the [System One contract](https://docs.typesafe.ai/api)
and Bearer authentication when enabled; arbitrary custom authentication is not supported.

### Generic System One readiness

Generic `systemone` connections allow model editing and report configuration
readiness only: there is no universal health endpoint and the app does not make a
paid probe. A configured connection is not proof that its service is reachable.
The app never automatically retries or falls back to another provider.

### Strands adapter behavior

The loaded checkpoint is fixed by the external service, so the model field is not
editable in Playground. Changing checkpoints requires updating the service and
the TOML entry. The health check compares the served model name with the final
component of the configured model name; it does not verify the exact weight revision.
Strands connections accept only explicit loopback HTTP, do not accept API keys,
and require `question_interaction = "independent"`.

The adapter requires at least two Choice options and string-only Score levels.
Unsupported input is rejected instead of converted. Original responses are saved
separately from normalized answers. Runtime installation, devices, memory,
context limits, and overflow policy belong to the external service; consult its
documentation for your selected version. A timeout may leave inference running
on that service; check it before manually retrying.

### Clef runtime and readiness

The example TOML uses model alias `clef` and port 8080. The app checks `/health` and
`/v1/models`, requiring the alias and `decisions` output modality before execution.
Older runtimes without that metadata cannot pass this adapter's readiness check.
Clef's full prompt must fit in `--ubatch-size`; 4096 is an example, not a guarantee
for every input. See the [v0.6.0 server documentation](https://github.com/ggml-org/llama.cpp/blob/v0.6.0/tools/server/README.md).
This app supports text/JSON only; no image-upload feature is included. Clef jointly
judges questions in one request, so changing one question can affect other answers.
No per-question splitting or semantic criteria conversion is performed. Structured
Score legends are preserved and displayed as JSON.

When starting `llama serve` without a model, router mode uses the published
`/v1/models` IDs; `--alias clef` on the router does not rename its cached models.
For this setup, use `model = "ggml-org/Clef-Flash-GGUF:Q4_K_M"` in TOML.
Set `timeout_ms = 300000` if cold loading exceeds the default 60 seconds and
restart Node/Hono after editing the file. Router readiness checks confirm the
model ID and decision capability; they do not force model loading. The first
inference request can therefore take longer than subsequent requests.

### Saved execution metadata

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

### Upgrading from environment-based Strands settings

Version 0.4 removes `LOCAL_DECISION_BASE_URL`, `LOCAL_DECISION_MODEL`, and
`LOCAL_DECISION_TIMEOUT_MS`. They no longer configure a connection. Add a Strands
entry to `systemone.toml` using the example above: append `/v1/systemone` to the
old origin for `endpoint`, and copy the model and timeout to their TOML fields.
Keep `id = "strands-local"` to reuse saved experiments with that connection ID.
Restart Node/Hono and check the connection, then remove the old variables.

Stored runs, labels, and original responses remain readable. Incomplete Suite
executions created with the old connection fingerprint require a new execution.

### Clef local acceptance (2026-10-10)

Automated tests use mock services. On 2026-10-10, the user reported successful
inference with llama.cpp v0.6.0 and cached `ggml-org/Clef-Flash-GGUF:Q4_K_M`
through router mode. The initial request was cancelled after about 60 seconds
while the model was loading; the connection timeout was increased to 300000 ms.
This confirms basic operation for that setup, not Japanese accuracy, a latency
benchmark, memory consumption, or overflow behavior.
