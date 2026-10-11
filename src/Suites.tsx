import { exampleDefinition, exampleSuite } from '../shared/exchange-examples';
import { serializeDocument } from '../shared/exchange';
import { useEffect, useRef, useState } from 'react';
import { api } from './api';
import type { AppConfig, ProviderId } from '../shared/providers';
import type { LocalUser } from '../shared/evaluation';
import type {
  ExchangeFormat,
  SavedDocument,
  Suite,
  SuiteProgress,
  ExperimentResults,
  LabelSource,
} from '../shared/exchange';

interface ExportFile {
  text: string;
  filename: string;
  format: ExchangeFormat;
}
function download(file: ExportFile) {
  const url = URL.createObjectURL(
    new Blob([file.text], {
      type: file.format === 'json' ? 'application/json' : 'application/yaml',
    }),
  );
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = file.filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
interface SuiteDetail extends Omit<Suite, 'cases'> {
  cases: { id: string; state: Suite['cases'][number]['state'] }[];
  expectedSeenAt: string | null;
  executions: SuiteProgress[];
}
export function SuitesWorkspace({
  user,
  config,
  initialProvider,
  selectedId,
  onSelect,
  executionId,
  onExecutionSelect: setExecutionId,
  onHelp,
  onEvaluate,
  onChanged,
}: {
  user: LocalUser;
  config: AppConfig | null;
  initialProvider: ProviderId;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  executionId: string;
  onExecutionSelect: (id: string) => void;
  onHelp: () => void;
  onEvaluate: (id: string, executionId: string, caseId: string) => void;
  onChanged: () => Promise<void>;
}) {
  const [documents, setDocuments] = useState<SavedDocument[]>([]);
  const [sources, setSources] = useState(['', '']);
  const [filenames, setFilenames] = useState(['', '']);
  const fileInputs = useRef<(HTMLInputElement | null)[]>([]);
  const [formats, setFormats] = useState<ExchangeFormat[]>(['yaml', 'yaml']);
  const [preview, setPreview] = useState<
    | {
        kind: string;
        name: string;
        version: number;
        caseCount?: number;
        questionCount?: number;
        expectedCount?: number;
      }[]
    | null
  >(null);
  const [detail, setDetail] = useState<SuiteDetail | null>(null);
  const [provider, setProvider] = useState(initialProvider);
  const [model, setModel] = useState(
    config?.providers[initialProvider]?.model ?? 'jev-latest',
  );
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const [source, setSource] = useState<LabelSource>('expected');
  const [result, setResult] = useState<ExperimentResults | null>(null);
  const [customSettings, setCustomSettings] = useState(false);
  const [threshold, setThreshold] = useState('0.5'),
    [tolerance, setTolerance] = useState('0.5');
  const lock = useRef(false),
    mounted = useRef(true);
  const lastProgress = useRef('');
  useEffect(() => {
    const key =
      detail?.executions
        .map(
          (e) => `${e.id}:${e.status}:${e.cases.filter((c) => c.runId).length}`,
        )
        .join('|') ?? '';
    if (key && key !== lastProgress.current) {
      lastProgress.current = key;
      void onChanged().catch((e) => {
        if (mounted.current) setError(e.message);
      });
    }
  }, [detail]);
  const initializedModel = useRef(Boolean(config));
  useEffect(() => {
    if (!initializedModel.current && config) {
      setModel(config.providers[provider]?.model ?? '');
      initializedModel.current = true;
    }
  }, [config, provider]);
  const request = <T,>(path: string, body?: unknown) =>
    api<T>(path, body, 'POST', user.id);
  const selection = config?.providers[provider];
  const executions = detail?.executions ?? [];
  const current = executions.find((e) => e.id === executionId) ?? executions[0];
  const exporting =
    current &&
    current.status !== 'running' &&
    current.cases.every((c) => !c.runId || c.revealed);
  const settings = customSettings
    ? { threshold: Number(threshold), tolerance: Number(tolerance) }
    : undefined;
  const settingsValid =
    !customSettings ||
    (threshold.trim() !== '' &&
      tolerance.trim() !== '' &&
      Number.isFinite(Number(threshold)) &&
      Number(threshold) >= 0 &&
      Number(threshold) <= 1 &&
      Number.isFinite(Number(tolerance)) &&
      Number(tolerance) >= 0);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    request<SavedDocument[]>('exchange/documents')
      .then((d) => {
        if (mounted.current) setDocuments(d);
      })
      .catch((e) => {
        if (mounted.current) setError(e.message);
      });
  }, []);
  useEffect(() => {
    setDetail(null);
    setResult(null);
    if (!selectedId) return;
    let active = true,
      timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const d = await request<SuiteDetail>(`suites/${selectedId}`);
        if (active) {
          setDetail(d);
          timer = setTimeout(poll, 1000);
        }
      } catch (e) {
        if (active) {
          setError(e instanceof Error ? e.message : 'Could not load the data.');
          timer = setTimeout(poll, 3000);
        }
      }
    }
    void poll();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [selectedId]);
  useEffect(() => {
    setResult(null);
  }, [source, executionId, threshold, tolerance, customSettings]);
  async function action(fn: () => Promise<void>) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await fn();
    } catch (e) {
      if (mounted.current)
        setError(e instanceof Error ? e.message : 'The operation failed.');
    } finally {
      lock.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  function edit(index: number, value: string, format = formats[index]) {
    setSources((s) => s.map((text, i) => (i === index ? value : text)));
    setFormats((f) => f.map((v, i) => (i === index ? format : v)));
    setPreview(null);
  }
  const payload = () => ({
    documents: sources.flatMap((text, i) =>
      text.trim() ? [{ source: text, format: formats[i] }] : [],
    ),
  });
  async function exportInput(id: string, format: ExchangeFormat) {
    download(
      await request<ExportFile>(`exchange/documents/${id}/export`, { format }),
    );
    setNotice(
      'Input exported. Exporting expectations records reference familiarity.',
    );
  }
  return (
    <>
      <header>
        <div>
          <div className="eyebrow">SUITES / EXPERIMENT EXCHANGE</div>
          <h1>
            {selectedId
              ? 'Suite execution and evaluation'
              : 'Experiment suites'}
          </h1>
          <p>
            Import decision definitions and cases authored with an LLM, then
            export evaluation results.
          </p>
        </div>
        <div className="toolbar">
          {selectedId && (
            <button onClick={() => onSelect(null)}>Back to suite list</button>
          )}
          <button onClick={onHelp}>Read the guide</button>
        </div>
      </header>
      {error && (
        <div className="alert" role="alert">
          {error}
        </div>
      )}
      {notice && (
        <div className="setup" role="status">
          {notice}
        </div>
      )}
      <div className="suite-grid" hidden={Boolean(selectedId)}>
        <section className="panel">
          <details open={!selectedId}>
            <summary>Import input files</summary>
            <p className="hint">
              Provide the definition and suite as separate files. You can also
              import one file. Importing a suite with expectations records
              reference familiarity.
            </p>
            <button
              disabled={busy}
              onClick={() => {
                setSources([
                  serializeDocument(exampleDefinition, 'yaml'),
                  serializeDocument(exampleSuite, 'yaml'),
                ]);
                setFormats(['yaml', 'yaml']);
                setPreview(null);
              }}
            >
              Use the routing example
            </button>
            {[0, 1].map((i) => (
              <div key={i}>
                <div className="suite-file-picker">
                  <span>Input file {i + 1}</span>
                  <button
                    type="button"
                    aria-label={`Choose input file ${i + 1}`}
                    disabled={busy}
                    onClick={() => fileInputs.current[i]?.click()}
                  >
                    Choose file
                  </button>
                  <span>{filenames[i] || 'No file selected'}</span>
                  <input
                    hidden
                    ref={(element) => {
                      fileInputs.current[i] = element;
                    }}
                    type="file"
                    aria-label={`Input file ${i + 1}`}
                    accept=".yaml,.yml,.json"
                    disabled={busy}
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      e.target.value = '';
                      if (!file) return;
                      if (file.size > 1024 * 1024) {
                        setError('Input must be 1 MiB or smaller.');
                        return;
                      }
                      void action(async () => {
                        const text = await file.text();
                        if (mounted.current) {
                          setFilenames((names) =>
                            names.map((name, index) =>
                              index === i ? file.name : name,
                            ),
                          );
                          edit(
                            i,
                            text,
                            file.name.endsWith('.json') ? 'json' : 'yaml',
                          );
                        }
                      });
                    }}
                  />
                </div>
                <label>
                  Format {i + 1}
                  <select
                    aria-label={`Input format ${i + 1}`}
                    value={formats[i]}
                    disabled={busy}
                    onChange={(e) =>
                      edit(i, sources[i], e.target.value as ExchangeFormat)
                    }
                  >
                    <option value="yaml">YAML</option>
                    <option value="json">JSON</option>
                  </select>
                </label>
                <textarea
                  className="exchange-source"
                  aria-label={`Input text ${i + 1}`}
                  value={sources[i]}
                  disabled={busy}
                  spellCheck={false}
                  onChange={(e) => edit(i, e.target.value)}
                  placeholder={
                    i === 0
                      ? 'decision-definition or experiment-suite'
                      : 'Second file (optional)'
                  }
                />
              </div>
            ))}
            <div className="toolbar">
              <button
                disabled={busy || !sources.some((s) => s.trim())}
                onClick={() =>
                  void action(async () => {
                    setPreview(await request('exchange/preview', payload()));
                  })
                }
              >
                Validate and preview
              </button>
              <button
                className="primary"
                disabled={busy || !preview}
                onClick={() =>
                  void action(async () => {
                    const saved = await request<SavedDocument[]>(
                      'exchange/import',
                      payload(),
                    );
                    setDocuments(await request('exchange/documents'));
                    setPreview(null);
                    setNotice('Input saved. No inference was performed.');
                    const suite = saved.find(
                      (d) => d.kind === 'experiment-suite',
                    );
                    if (suite) onSelect(suite.id);
                  })
                }
              >
                Save input
              </button>
            </div>
            {preview && (
              <div className="setup" aria-label="Import preview">
                {preview.map((p) => (
                  <p key={p.kind}>
                    {p.name} v{p.version} · {p.kind} ·{' '}
                    {p.caseCount !== undefined
                      ? `${p.caseCount} cases / with expectations ${p.expectedCount}`
                      : `${p.questionCount} questions`}
                  </p>
                ))}
              </div>
            )}
          </details>
        </section>
        <section className="panel">
          <h2>Saved suites and decision definitions</h2>
          {!documents.length && (
            <p className="muted">Save input to reuse it here.</p>
          )}
          {documents.map((d) => (
            <div className="exchange-document" key={d.id}>
              <strong>
                {d.name} v{d.version}
              </strong>
              <small>
                {d.kind === 'experiment-suite'
                  ? 'Experiment Suite'
                  : 'Decision Definition'}
              </small>
              <div className="toolbar">
                {d.kind === 'experiment-suite' && (
                  <button
                    aria-pressed={selectedId === d.id}
                    onClick={() => onSelect(d.id)}
                  >
                    Open suite
                  </button>
                )}
                {(['yaml', 'json'] as const).map((f) => (
                  <button
                    key={f}
                    disabled={busy}
                    onClick={() => void action(() => exportInput(d.id, f))}
                  >
                    {f.toUpperCase()} input export
                    {d.kind === 'experiment-suite'
                      ? ' (includes expectations)'
                      : ''}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </section>
      </div>
      {selectedId && !detail && <p role="status">Loading suite…</p>}
      {detail && (
        <section className="panel suite-detail">
          <h2>
            {detail.name} v{detail.version} · {detail.cases.length} cases
          </h2>
          <p>
            Decision definition: {detail.definition.name} v
            {detail.definition.version} · Expectations:{' '}
            {detail.expectedSeenAt ? 'Viewed' : 'Not viewed'}
          </p>
          <details className="suite-input-export">
            <summary>Export input files</summary>
            <p className="hint">
              Exporting input with expectations records reference familiarity.
            </p>
            <div className="toolbar">
              {documents
                .filter(
                  (d) =>
                    d.id === selectedId ||
                    (d.kind === 'decision-definition' &&
                      d.name === detail.definition.name &&
                      d.version === detail.definition.version),
                )
                .map((d) => (
                  <div key={d.id}>
                    <strong>
                      {d.kind === 'experiment-suite'
                        ? 'Suite'
                        : 'Decision definition'}
                    </strong>
                    {(['yaml', 'json'] as const).map((format) => (
                      <button
                        key={format}
                        disabled={busy}
                        onClick={() =>
                          void action(() => exportInput(d.id, format))
                        }
                      >
                        {format.toUpperCase()} input export
                      </button>
                    ))}
                  </div>
                ))}
            </div>
          </details>
          <h3>1. Create a new execution</h3>
          <div className="toolbar">
            <label>
              Suite connection
              <select
                aria-label="Suite connection"
                value={provider}
                disabled={busy}
                onChange={(e) => {
                  setProvider(e.target.value);
                  setModel(config?.providers[e.target.value]?.model ?? '');
                }}
              >
                {config &&
                  Object.entries(config.providers).map(([id, p]) => (
                    <option key={id} value={id}>
                      {p.label ?? id}
                      {p.configured ? '' : ' (not configured)'}
                    </option>
                  ))}
              </select>
            </label>
            <label>
              Suite model
              <input
                aria-label="Suite model"
                value={model}
                disabled={busy || selection?.modelEditable === false}
                onChange={(e) => setModel(e.target.value)}
              />
            </label>
            <button
              className="primary"
              disabled={
                busy ||
                !selection?.configured ||
                !model.trim() ||
                executions.some((e) => e.status === 'running')
              }
              onClick={() =>
                void action(async () => {
                  const e = await request<SuiteProgress>(
                    `suites/${selectedId}/execute`,
                    { provider, model },
                  );
                  setExecutionId(e.id);
                  setResult(null);
                  setDetail(await request(`suites/${selectedId}`));
                })
              }
            >
              Run suite sequentially
            </button>
          </div>
          <p className="hint">
            Run sequentially with one connection and stop on the first failure.
            Resume skips successful cases. Paid providers such as Jev charge for
            each case.
          </p>
          {current && (
            <>
              <h3>2. Select an execution and evaluate its cases</h3>
              <label>
                Suite execution history
                <select
                  aria-label="Suite execution history"
                  value={current.id}
                  onChange={(e) => {
                    setExecutionId(e.target.value);
                    setResult(null);
                  }}
                >
                  {executions.map((e) => (
                    <option key={e.id} value={e.id}>
                      {e.provider} / {e.model} ·{' '}
                      {new Date(e.createdAt).toLocaleString('en-US')} ·{' '}
                      {e.status}
                    </option>
                  ))}
                </select>
              </label>
              <p role="status">
                Execution status: {current.status} · Succeeded{' '}
                {current.cases.filter((c) => c.status === 'succeeded').length} /{' '}
                {current.cases.length}
              </p>
              {(current.status === 'stopped' ||
                current.status === 'interrupted') && (
                <button
                  disabled={busy || current.userId !== user.id}
                  onClick={() =>
                    void action(async () => {
                      await request(
                        `suite-executions/${current.id}/resume`,
                        {},
                      );
                      setResult(null);
                      setDetail(await request(`suites/${selectedId}`));
                    })
                  }
                >
                  Resume unfinished cases
                </button>
              )}
              <p className="hint">
                Finalize labels for each case, then return to this execution.
              </p>
              <div className="suite-table">
                <table>
                  <thead>
                    <tr>
                      <th> cases</th>
                      <th>Execution</th>
                      <th>Attempts</th>
                      <th>Evaluation</th>
                    </tr>
                  </thead>
                  <tbody>
                    {current.cases.map((c) => (
                      <tr key={c.caseId}>
                        <td>{c.caseId}</td>
                        <td>
                          {c.status}
                          {c.attempts.at(-1)?.error && (
                            <p className="validation">
                              {c.attempts.at(-1)?.error?.message}
                            </p>
                          )}
                        </td>
                        <td>{c.attempts.length}</td>
                        <td>
                          {c.runId ? (
                            <button
                              onClick={() =>
                                onEvaluate(c.runId!, current.id, c.caseId)
                              }
                            >
                              {c.revealed
                                ? 'Open evaluation'
                                : 'Open blind evaluation'}
                            </button>
                          ) : (
                            '—'
                          )}
                          {c.runId && (
                            <small>
                              {c.finalized ? 'Finalized' : 'Not finalized'} ·{' '}
                              {c.revealed ? 'Revealed' : 'Hidden'}
                            </small>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <h3>3. Summarize and export results</h3>
              <div className="toolbar">
                <label>
                  Grading source
                  <select
                    aria-label="Grading source"
                    value={source}
                    onChange={(e) => setSource(e.target.value as LabelSource)}
                  >
                    <option value="expected">Imported expectations</option>
                    <option value="individual">
                      My latest finalized labels
                    </option>
                    <option value="reference">
                      Latest adopted reference revision
                    </option>
                  </select>
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={customSettings}
                    onChange={(e) => setCustomSettings(e.target.checked)}
                  />{' '}
                  Override grading settings
                </label>
                {customSettings && (
                  <>
                    <label>
                      Noul threshold
                      <input
                        aria-label="Suite Noul threshold"
                        type="number"
                        min="0"
                        max="1"
                        step="0.05"
                        value={threshold}
                        onChange={(e) => setThreshold(e.target.value)}
                      />
                    </label>
                    <label>
                      Score tolerance
                      <input
                        aria-label="Suite Score tolerance"
                        type="number"
                        min="0"
                        step="0.1"
                        value={tolerance}
                        onChange={(e) => setTolerance(e.target.value)}
                      />
                    </label>
                  </>
                )}
              </div>
              <p className="hint">
                Finalize or explicitly reveal all successful cases as the
                exporting user to summarize and export results. Missing labels
                and failed cases are excluded from accuracy denominators.
              </p>
              <div className="toolbar">
                <button
                  disabled={busy || !exporting || !settingsValid}
                  onClick={() =>
                    void action(async () => {
                      setResult(
                        await request(
                          `suite-executions/${current.id}/results`,
                          { source, ...(settings ? { settings } : {}) },
                        ),
                      );
                    })
                  }
                >
                  Summarize results
                </button>
                {(['yaml', 'json'] as const).map((f) => (
                  <button
                    key={f}
                    disabled={busy || !exporting || !settingsValid}
                    onClick={() =>
                      void action(async () => {
                        download(
                          await request<ExportFile>(
                            `suite-executions/${current.id}/export`,
                            {
                              source,
                              format: f,
                              ...(settings ? { settings } : {}),
                            },
                          ),
                        );
                        setNotice('Results exported.');
                        await onChanged();
                      })
                    }
                  >
                    {f.toUpperCase()} results export
                  </button>
                ))}
              </div>
              {result && (
                <>
                  <div className="metrics">
                    <div>
                      <small>NOUL CORRECT / GRADED</small>
                      <strong>
                        {result.summary.noul.correct} /{' '}
                        {result.summary.noul.total}
                      </strong>
                    </div>
                    <div>
                      <small>CHOICE CORRECT / GRADED</small>
                      <strong>
                        {result.summary.choice.correct} /{' '}
                        {result.summary.choice.total}
                      </strong>
                    </div>
                    <div>
                      <small>SCORE MAE</small>
                      <strong>
                        {result.summary.score.mae?.toFixed(3) ?? '—'}
                      </strong>
                    </div>
                  </div>
                  <p>
                    Missing labels {result.summary.missingLabels} · Failed /
                    interrupted {result.summary.failedCases} · Unfinished{' '}
                    {result.summary.pendingCases}
                  </p>
                  <details>
                    <summary>Case grading and provenance</summary>
                    <pre className="state-snapshot">
                      {JSON.stringify(
                        result.results.map((r) => ({
                          caseId: r.caseId,
                          grading: r.grading,
                          modelExposure: r.modelExposure,
                          expectedSeenAt: r.expectedSeenAt,
                        })),
                        null,
                        2,
                      )}
                    </pre>
                  </details>
                </>
              )}
            </>
          )}
        </section>
      )}
    </>
  );
}
