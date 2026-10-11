import { displayUserName } from './user-name';
import React, {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';
import { createRoot } from 'react-dom/client';
import {
  initialQuery,
  requestSchema,
  type Query,
  type Question,
  type Run,
} from '../shared/schema';
import './style.css';
import { ResultView } from './ResultView';
import { EvaluationWorkspace } from './Evaluation';
import { SuitesWorkspace } from './Suites';
import type { HelpTopic } from './Help';
const Help = React.lazy(() =>
  import('./Help').then((module) => ({ default: module.Help })),
);
import {
  providerIdSchema,
  type ProviderId,
  type ProviderHealth,
  type AppConfig,
} from '../shared/providers';
import type { LocalUser, RunSummary, Labeling } from '../shared/evaluation';
type Experiment = {
  id: string;
  title: string;
  query: Query;
  createdAt: string;
  createdByUserId?: string;
  provider?: ProviderId;
};
import { api } from './api';
const pretty = (value: unknown) => JSON.stringify(value, null, 2);
const DraftValidity = createContext<(label: string, invalid: boolean) => void>(
  () => {},
);
function App({
  user,
  users,
  beforeSwitch,
}: {
  user: LocalUser;
  users: LocalUser[];
  beforeSwitch: React.MutableRefObject<null | (() => Promise<void>)>;
}) {
  const request = <T,>(path: string, body?: unknown, method = 'POST') =>
    api<T>(path, body, method, user.id);
  const [workspace, setWorkspace] = useState<
    'playground' | 'evaluation' | 'suites'
  >('playground');
  const [helpTopic, setHelpTopic] = useState<HelpTopic | null>(null);
  const helpScroll = useRef(0);
  const [navigationError, setNavigationError] = useState('');
  const [suiteExecutionId, setSuiteExecutionId] = useState('');
  const [suiteOrigin, setSuiteOrigin] = useState<{
    suiteId: string;
    executionId: string;
    caseId: string;
  } | null>(null);
  const [suiteId, setSuiteId] = useState<string | null>(null);
  const [evaluationId, setEvaluationId] = useState<string | null>(null);
  const [blind, setBlind] = useState(true);
  const [provider, setProvider] = useState<ProviderId>(
    () =>
      providerIdSchema.safeParse(localStorage.getItem('decisionProvider'))
        .data ?? 'jev',
  );
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [health, setHealth] = useState<ProviderHealth | null>(null);
  const [checking, setChecking] = useState(false);
  const models = useRef(new Map<string, string>([['jev', 'jev-latest']]));
  const configLoaded = useRef(false);
  const healthGeneration = useRef(0);
  const selectedConfig =
    config && Object.hasOwn(config.providers, provider)
      ? config.providers[provider]
      : undefined;
  const modelEditable = selectedConfig?.modelEditable ?? provider === 'jev';
  const canCheck = selectedConfig?.healthCheck ?? false;
  const [invalidFields, setInvalidFields] = useState<Record<string, boolean>>(
    {},
  );
  const fieldError = Object.values(invalidFields).some(Boolean);
  const reportInvalid = React.useCallback(
    (label: string, invalid: boolean) =>
      setInvalidFields((prev) =>
        prev[label] === invalid ? prev : { ...prev, [label]: invalid },
      ),
    [],
  );
  const [query, setQuery] = useState<Query>(() => ({
      ...initialQuery,
      model: initialQuery.model,
    })),
    [json, setJson] = useState(() =>
      pretty({
        ...initialQuery,
        model: initialQuery.model,
      }),
    ),
    [mode, setMode] = useState<'form' | 'json'>('form');
  const [title, setTitle] = useState('Support request triage'),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [busy, setBusy] = useState(false),
    [configured, setConfigured] = useState<boolean | null>(null);
  const [runs, setRuns] = useState<RunSummary[]>([]),
    [experiments, setExperiments] = useState<Experiment[]>([]),
    [result, setResult] = useState<Run | null>(null);
  const lock = useRef(false);
  const valid = requestSchema.safeParse(query);
  const parseJson = () => {
    try {
      return requestSchema.parse(JSON.parse(json));
    } catch {
      return null;
    }
  };
  const jsonValid = mode === 'form' || Boolean(parseJson());
  async function refresh() {
    const [r, e, c] = await Promise.all([
      request<RunSummary[]>('runs/summaries'),
      request<Experiment[]>('experiments'),
      request<AppConfig>('config'),
    ]);
    setRuns(r);
    setExperiments(e);
    setConfigured(c.configured);
    setConfig(c);
    if (
      !configLoaded.current &&
      Object.hasOwn(c.providers, provider) &&
      provider !== 'jev'
    )
      update({ ...query, model: c.providers[provider].model });
    configLoaded.current = true;
  }
  useEffect(() => {
    refresh().catch((e) => setError(e.message));
  }, []);
  async function checkLocal() {
    const generation = ++healthGeneration.current;
    const selected = provider;
    setChecking(true);
    try {
      const result = await request<ProviderHealth>(
        `providers/${selected}/health`,
      );
      if (generation === healthGeneration.current) setHealth(result);
    } catch {
      if (generation === healthGeneration.current)
        setHealth({ status: 'unreachable' });
    } finally {
      if (generation === healthGeneration.current) setChecking(false);
    }
  }
  useEffect(() => {
    ++healthGeneration.current;
    setHealth(null);
    setChecking(false);
    if (canCheck) void checkLocal();
    return () => {
      ++healthGeneration.current;
    };
  }, [provider, canCheck]);
  function chooseProvider(next: ProviderId, q?: Query) {
    if (!q && fieldError) {
      setError('Fix the form input before switching connections.');
      return;
    }
    const current = q ?? (mode === 'json' ? parseJson() : query);
    if (!current) {
      setError('Fix the JSON before switching connections.');
      return;
    }
    ++healthGeneration.current;
    if (!q) models.current.set(provider, current.model);
    setProvider(next);
    localStorage.setItem('decisionProvider', next);
    update({
      ...current,
      model: q
        ? config?.providers[next]?.modelEditable === false
          ? config.providers[next].model
          : q.model
        : config?.providers[next]?.modelEditable === false
          ? config.providers[next].model
          : (models.current.get(next) ??
            config?.providers[next]?.model ??
            initialQuery.model),
    });
    setResult(null);
    setError('');
  }
  function update(next: Query) {
    setQuery(next);
    setJson(pretty(next));
    setNotice('');
  }
  async function navigate(fn: () => void) {
    setNavigationError('');
    try {
      await beforeSwitch.current?.();
      setHelpTopic(null);
      fn();
    } catch (e) {
      setNavigationError(
        e instanceof Error ? e.message : 'Could not save the label draft.',
      );
    }
  }
  async function openHelp(topic: HelpTopic) {
    await navigate(() => {
      if (!helpTopic) helpScroll.current = window.scrollY;
      setHelpTopic(topic);
    });
  }
  function closeHelp() {
    setHelpTopic(null);
    requestAnimationFrame(() => window.scrollTo({ top: helpScroll.current }));
  }
  function load(q: Query, t: string, next: ProviderId) {
    chooseProvider(next, q);
    setTitle(t);
    setMode('form');
  }
  async function submit(kind: 'runs' | 'experiments') {
    if (lock.current || fieldError) return;
    const q = mode === 'json' ? parseJson() : valid.success ? valid.data : null;
    if (!q) {
      setError('Check the request format.');
      return;
    }
    lock.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const saved = await request<Run | Experiment | Labeling>(kind, {
        title,
        query: q,
        provider,
        blind: kind === 'runs' ? blind : undefined,
      });
      if (kind === 'runs') {
        setSuiteOrigin(null);
        if (blind) {
          setResult(null);
          setEvaluationId((saved as Labeling).run.id);
          setWorkspace('evaluation');
        } else setResult(saved as Run);
      } else setNotice('Experiment saved.');
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The operation failed.');
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  function changeQuestion(id: string, q: Question) {
    update({ ...query, questions: { ...query.questions, [id]: q } });
  }
  function addQuestion() {
    let n = 1;
    while (`question_${n}` in query.questions) n++;
    changeQuestion(`question_${n}`, { type: 'noul', instructions: '' });
  }
  return (
    <DraftValidity.Provider value={reportInvalid}>
      <div className="shell">
        <aside>
          <a className="brand" href="/">
            J<span>ev</span>
            <small>DECISION LAB</small>
          </a>
          <div className="workspace">◉ &nbsp; LOCAL WORKSPACE</div>
          <h2>
            Saved experiments <span>{experiments.length}</span>
          </h2>
          {experiments.length === 0 && (
            <p className="muted">Save an experiment to reuse it here.</p>
          )}
          {experiments.map((e) => (
            <button
              className="history"
              key={e.id}
              onClick={() => {
                void navigate(() => {
                  setWorkspace('playground');
                  load(e.query, e.title, e.provider ?? 'jev');
                });
              }}
            >
              {e.title}
              <small>
                {displayUserName(users.find((u) => u.id === e.createdByUserId))}{' '}
                · {new Date(e.createdAt).toLocaleString('en-US')}
              </small>
            </button>
          ))}
          <h2>
            Run history <span>{runs.length}</span>
          </h2>
          {runs.length === 0 && (
            <p className="muted">Run your first decision.</p>
          )}
          {runs.map((r) => (
            <button
              className="history"
              key={r.id}
              onClick={() => {
                void navigate(() => {
                  setResult(null);
                  setSuiteOrigin(null);
                  setEvaluationId(r.id);
                  setWorkspace('evaluation');
                });
              }}
            >
              {r.title}
              <small>
                {r.finalized ? 'Labels finalized' : 'Labels not finalized'} ·{' '}
                {r.exposure === 'blind' ? 'Answers hidden' : 'Viewed / unknown'}
              </small>
            </button>
          ))}
          <footer>
            Typed judgments.
            <br />
            Ideas into decisions.
            <p>
              <button
                className="footer-link"
                onClick={() => void openHelp('license')}
              >
                MIT License
              </button>
              {' · '}
              <button
                className="footer-link"
                onClick={() => void openHelp('notices')}
              >
                Third-party notices
              </button>
            </p>
          </footer>
        </aside>
        <main>
          <div className="workspace-tabs">
            <button
              aria-pressed={!helpTopic && workspace === 'playground'}
              onClick={() => void navigate(() => setWorkspace('playground'))}
            >
              Playground
            </button>
            <button
              aria-pressed={!helpTopic && workspace === 'evaluation'}
              onClick={() =>
                void navigate(() => {
                  setResult(null);
                  setWorkspace('evaluation');
                })
              }
            >
              Evaluation
            </button>
            <button
              aria-pressed={!helpTopic && workspace === 'suites'}
              onClick={() => void navigate(() => setWorkspace('suites'))}
            >
              Suites
            </button>
            <button
              aria-pressed={helpTopic !== null}
              onClick={() => void openHelp('guide')}
            >
              Help
            </button>
          </div>
          {navigationError && (
            <div role="alert" className="alert">
              {navigationError}
            </div>
          )}
          {helpTopic && (
            <React.Suspense
              fallback={<p role="status">Loading documentation…</p>}
            >
              <Help
                topic={helpTopic}
                onTopic={setHelpTopic}
                onBack={closeHelp}
              />
            </React.Suspense>
          )}
          <div hidden={helpTopic !== null}>
            {workspace === 'suites' ? (
              <SuitesWorkspace
                user={user}
                config={config}
                initialProvider={provider}
                selectedId={suiteId}
                executionId={suiteExecutionId}
                onExecutionSelect={setSuiteExecutionId}
                onHelp={() => void openHelp('guide')}
                onSelect={(id) => {
                  setSuiteId(id);
                  setSuiteExecutionId('');
                }}
                onEvaluate={(id, executionId, caseId) => {
                  setSuiteOrigin({ suiteId: suiteId!, executionId, caseId });
                  setSuiteExecutionId(executionId);
                  setEvaluationId(id);
                  setWorkspace('evaluation');
                }}
                onChanged={refresh}
              />
            ) : workspace === 'evaluation' ? (
              <>
                {suiteOrigin && (
                  <div className="panel suite-return">
                    <span>Suites / Case {suiteOrigin.caseId}</span>
                    <button
                      onClick={() =>
                        void navigate(() => {
                          setSuiteId(suiteOrigin.suiteId);
                          setSuiteExecutionId(suiteOrigin.executionId);
                          setWorkspace('suites');
                        })
                      }
                    >
                      Back to suite execution
                    </button>
                  </div>
                )}
                <EvaluationWorkspace
                  key={evaluationId ?? 'none'}
                  runId={evaluationId}
                  user={user}
                  users={users}
                  beforeSwitch={beforeSwitch}
                  onCopy={(q, t, p) =>
                    void navigate(() => {
                      load(q, t, p ?? 'jev');
                      setWorkspace('playground');
                    })
                  }
                  onChanged={refresh}
                />
              </>
            ) : (
              <>
                <header>
                  <div>
                    <div className="eyebrow">PLAYGROUND / DECISION LAB</div>
                    <h1>Make decisions. Explore probabilities.</h1>
                    <p>
                      Build input and questions to inspect model judgments and
                      their probabilities.
                    </p>
                  </div>
                  <div
                    className={`status ${(canCheck ? health?.status === 'ready' : selectedConfig?.configured) ? 'ready' : ''}`}
                  >
                    ●{' '}
                    {canCheck
                      ? health?.status === 'ready'
                        ? 'Connection verified'
                        : 'Not connected'
                      : selectedConfig?.configured
                        ? 'Configured · connection not verified'
                        : 'Not configured'}
                  </div>
                </header>
                {provider === 'jev' && configured === false && (
                  <div className="setup">
                    To get started, set <code>TYPESAFE_API_KEY</code> in{' '}
                    <code>.env</code> and restart the server.
                  </div>
                )}
                <div className="panel provider-panel">
                  <label>
                    Connection
                    <select
                      aria-label="Connection"
                      value={provider}
                      disabled={busy}
                      onChange={(e) =>
                        chooseProvider(e.target.value as ProviderId)
                      }
                    >
                      {config &&
                        Object.entries(config.providers).map(([id, value]) => (
                          <option key={id} value={id}>
                            {value.label ?? id}
                          </option>
                        ))}
                      {!selectedConfig && (
                        <option value={provider}>
                          {provider} (not registered)
                        </option>
                      )}
                    </select>
                  </label>
                  {canCheck && (
                    <>
                      <p>Configured model: {selectedConfig?.model}</p>
                      <button
                        disabled={checking || busy}
                        onClick={() => void checkLocal()}
                      >
                        Check connection
                      </button>
                      <p role="status">
                        {health?.status === 'ready'
                          ? `Connected · ${health.model}${health.device ? ` · ${health.device}` : ''}`
                          : health?.status === 'mismatch'
                            ? 'Model mismatch: check the server and configuration.'
                            : health?.status === 'unconfigured'
                              ? 'Check the server-side connection settings.'
                              : 'Start the inference server and check the connection.'}
                      </p>
                      {selectedConfig?.guidance && (
                        <p className="hint">{selectedConfig.guidance}</p>
                      )}
                    </>
                  )}
                  {!selectedConfig && (
                    <p role="status">
                      This connection was removed. Select a connection to run
                      again.
                    </p>
                  )}
                  {selectedConfig?.questionInteraction === 'joint' && (
                    <p className="hint">
                      This connection judges questions jointly in the same
                      request. Questions are not independent.
                    </p>
                  )}
                  {selectedConfig?.questionInteraction === 'unknown' && (
                    <p className="hint">
                      Question independence is unknown for this connection.
                    </p>
                  )}
                </div>
                <label className="blind-toggle">
                  <input
                    type="checkbox"
                    checked={blind}
                    onChange={(e) => {
                      setBlind(e.target.checked);
                      setResult(null);
                    }}
                  />{' '}
                  Blind execution (hide answers until labels are finalized)
                </label>
                <div className="toolbar">
                  <label className="title-label">
                    Experiment name
                    <input
                      aria-label="Experiment name"
                      maxLength={120}
                      value={title}
                      onChange={(e) => setTitle(e.target.value)}
                    />
                  </label>
                  <button
                    disabled={
                      fieldError ||
                      busy ||
                      !jsonValid ||
                      !valid.success ||
                      !title.trim()
                    }
                    onClick={() => submit('experiments')}
                  >
                    Save experiment
                  </button>
                  <button
                    className="primary"
                    disabled={
                      fieldError ||
                      busy ||
                      !selectedConfig?.configured ||
                      !jsonValid ||
                      !valid.success ||
                      !title.trim()
                    }
                    onClick={() => submit('runs')}
                  >
                    {busy ? 'Running…' : 'Run decision ↗'}
                  </button>
                </div>
                {error && (
                  <div role="alert" className="alert">
                    {error}
                  </div>
                )}
                {notice && (
                  <div role="status" className="setup">
                    {notice}
                  </div>
                )}
                <div className="columns">
                  <section className="panel editor">
                    <div className="panel-heading">
                      <h2>
                        01 <span>Build a request</span>
                      </h2>
                      <div className="tabs">
                        <button
                          aria-pressed={mode === 'form'}
                          onClick={() => {
                            const parsed = parseJson();
                            if (mode === 'json' && !parsed) {
                              setError(
                                'Fix the JSON before switching to the form.',
                              );
                              return;
                            }
                            if (parsed && mode === 'json') update(parsed);
                            setMode('form');
                          }}
                        >
                          Form
                        </button>
                        <button
                          aria-pressed={mode === 'json'}
                          onClick={() => {
                            setJson(pretty(query));
                            if (fieldError) {
                              setError(
                                'Fix invalid input before switching views.',
                              );
                              return;
                            }
                            setMode('json');
                          }}
                        >
                          JSON
                        </button>
                      </div>
                    </div>
                    <label>
                      Model
                      <input
                        aria-label="Model"
                        readOnly={!modelEditable}
                        value={query.model}
                        onChange={(e) =>
                          update({ ...query, model: e.target.value })
                        }
                      />
                    </label>
                    {mode === 'json' ? (
                      <>
                        <label>
                          Request JSON
                          <textarea
                            className="code"
                            aria-label="Request JSON"
                            rows={24}
                            value={json}
                            onChange={(e) => {
                              setJson(e.target.value);
                              try {
                                const q = requestSchema.parse(
                                  JSON.parse(e.target.value),
                                );
                                setQuery(q);
                              } catch {
                                /* preserve invalid draft */
                              }
                            }}
                          />
                        </label>
                        {!jsonValid && (
                          <p role="alert" className="validation">
                            Invalid JSON syntax or request format. Cannot
                            submit.
                          </p>
                        )}
                      </>
                    ) : (
                      <>
                        <StateEditor
                          value={query.state}
                          onChange={(state) => update({ ...query, state })}
                        />
                        <div className="section-title">
                          <h3>
                            Questions{' '}
                            <span>{Object.keys(query.questions).length}</span>
                          </h3>
                          <button onClick={addQuestion}>＋ Add question</button>
                        </div>
                        {Object.entries(query.questions).map(([id, q], i) => (
                          <div className="question" key={id}>
                            <div className="question-header">
                              <span className="question-number">
                                {String(i + 1).padStart(2, '0')}
                              </span>
                              <input
                                aria-label={`Question ID ${i + 1}`}
                                defaultValue={id}
                                onBlur={(e) => {
                                  const next = e.target.value.trim();
                                  if (next === id) return;
                                  if (
                                    !next ||
                                    Object.hasOwn(query.questions, next)
                                  ) {
                                    e.target.value = id;
                                    setError(
                                      'Question IDs must be nonempty and unique.',
                                    );
                                    return;
                                  }
                                  update({
                                    ...query,
                                    questions: Object.fromEntries(
                                      Object.entries(query.questions).map(
                                        ([key, v]) => [
                                          key === id ? next : key,
                                          v,
                                        ],
                                      ),
                                    ),
                                  });
                                }}
                              />
                              <select
                                aria-label={`Question type ${i + 1}`}
                                value={q.type}
                                onChange={(e) => {
                                  const type = e.target
                                    .value as Question['type'];
                                  changeQuestion(
                                    id,
                                    type === 'noul'
                                      ? { type, instructions: q.instructions }
                                      : type === 'choice'
                                        ? {
                                            type,
                                            instructions: q.instructions,
                                            criteria: {
                                              option_a: 'Option A',
                                              option_b: 'Option B',
                                            },
                                          }
                                        : {
                                            type,
                                            instructions: q.instructions,
                                            criteria: ['Low', 'High'],
                                          },
                                  );
                                }}
                              >
                                <option value="noul">Noul · Yes / No</option>
                                <option value="choice">
                                  Choice · Selection
                                </option>
                                <option value="score">Score · Rating</option>
                              </select>
                              <button
                                aria-label={`Remove question ${id}`}
                                onClick={() =>
                                  update({
                                    ...query,
                                    questions: Object.fromEntries(
                                      Object.entries(query.questions).filter(
                                        ([k]) => k !== id,
                                      ),
                                    ),
                                  })
                                }
                              >
                                ×
                              </button>
                            </div>
                            <ContentEditor
                              label={`Instructions ${id}`}
                              value={q.instructions}
                              onChange={(instructions) =>
                                changeQuestion(id, { ...q, instructions })
                              }
                            />
                            {q.type !== 'noul' && (
                              <CriteriaEditor
                                kind={q.type}
                                label={`Criteria ${id}`}
                                value={q.criteria}
                                onChange={(criteria) => {
                                  const parsed =
                                    requestSchema.shape.questions.safeParse({
                                      [id]: { ...q, criteria },
                                    });
                                  if (!parsed.success) return false;
                                  changeQuestion(id, parsed.data[id]);
                                  return true;
                                }}
                              />
                            )}
                            {q.type === 'noul' && (
                              <details>
                                <summary>Yes / No criteria (optional)</summary>
                                <CriteriaEditor
                                  kind="noul"
                                  label={`Criteria ${id}`}
                                  value={q.criteria ?? { true: '', false: '' }}
                                  onChange={(criteria) => {
                                    const parsed =
                                      requestSchema.shape.questions.safeParse({
                                        [id]: { ...q, criteria },
                                      });
                                    if (!parsed.success) return false;
                                    changeQuestion(id, parsed.data[id]);
                                    return true;
                                  }}
                                />
                              </details>
                            )}
                          </div>
                        ))}
                        {!valid.success && (
                          <p className="validation">
                            {valid.error.issues
                              .map((i) => i.message)
                              .join(' / ')}
                          </p>
                        )}
                      </>
                    )}
                  </section>
                  <section className="panel results">
                    <div className="panel-heading">
                      <h2>
                        02 <span>Explore the decision</span>
                      </h2>
                      <span className="eyebrow">RESPONSE</span>
                    </div>
                    {!result ? (
                      <div className="empty">
                        <div className="empty-icon">⌘</div>
                        <h3>Your decision results appear here.</h3>
                        <p>
                          Prepare questions and select Run decision to inspect
                          <br />
                          answers and the probability of each option.
                        </p>
                        <div className="legend">
                          <span>Noul</span>
                          <span>Choice</span>
                          <span>Score</span>
                        </div>
                      </div>
                    ) : (
                      <>
                        <ResultView result={result} />
                      </>
                    )}
                  </section>
                </div>
                <div className="bottom-note">
                  Decision models · No automatic retries · Input and results are
                  stored locally
                </div>
              </>
            )}
          </div>
        </main>
      </div>
    </DraftValidity.Provider>
  );
}
type CriterionRow = { key: string; value: unknown };
function CriteriaEditor({
  kind,
  label,
  value,
  onChange,
}: {
  kind: 'choice' | 'score' | 'noul' | 'record';
  label: string;
  value: unknown;
  onChange: (value: unknown) => boolean;
}) {
  const reportInvalid = useContext(DraftValidity);
  const toRows = (v: unknown): CriterionRow[] =>
    Object.entries((v ?? {}) as Record<string, unknown>).map(
      ([key, value]) => ({ key, value }),
    );
  const [rows, setRows] = useState(() => toRows(value));
  const [invalid, setInvalid] = useState(false);
  const committed = useRef(pretty(value));
  useEffect(() => {
    if (pretty(value) !== committed.current) {
      setRows(toRows(value));
      setInvalid(false);
      committed.current = pretty(value);
    }
  }, [value]);
  useEffect(() => {
    reportInvalid(label, invalid);
    return () => reportInvalid(label, false);
  }, [label, invalid, reportInvalid]);
  const apply = (next: CriterionRow[]) => {
    setRows(next);
    const keys = next.map((r) => r.key);
    if (
      kind !== 'score' &&
      (keys.some((k) => !k.trim()) || new Set(keys).size !== keys.length)
    ) {
      setInvalid(true);
      return;
    }
    const result =
      kind === 'score'
        ? next.map((r) => r.value)
        : Object.fromEntries(next.map((r) => [r.key, r.value]));
    if (onChange(result)) {
      committed.current = pretty(result);
      setInvalid(false);
    } else setInvalid(true);
  };
  const add = () => {
    let key = '';
    if (kind === 'noul') {
      key = rows.some((r) => r.key === 'true') ? 'false' : 'true';
    } else {
      let n = 1;
      while (rows.some((r) => r.key === `option_${n}`)) n++;
      key = `option_${n}`;
    }
    apply([...rows, { key, value: '' }]);
  };
  const max =
    kind === 'score'
      ? 10
      : kind === 'noul'
        ? 2
        : kind === 'choice'
          ? 255
          : Infinity;
  return (
    <div className="criteria-editor">
      <div className="section-title">
        <h3>{label}</h3>
        <button
          type="button"
          aria-label={`Add criterion ${label}`}
          disabled={rows.length >= max}
          onClick={add}
        >
          ＋ Add
        </button>
      </div>
      {rows.map((row, index) => (
        <div className="criterion-row" key={index}>
          <label>
            {kind === 'score' ? 'Level' : 'key'}
            <input
              aria-label={`${label} key ${index + 1}`}
              value={kind === 'score' ? String(index) : row.key}
              readOnly={kind === 'score' || kind === 'noul'}
              onChange={(e) =>
                apply(
                  rows.map((r, i) =>
                    i === index ? { ...r, key: e.target.value } : r,
                  ),
                )
              }
            />
          </label>
          <label>
            value
            {row.value !== null && typeof row.value === 'object' ? (
              <div className="structured-value">
                <span>Structured data</span>
                <pre>{pretty(row.value)}</pre>
                <small>Edit in JSON mode</small>
              </div>
            ) : (
              <textarea
                aria-label={`${label} value ${index + 1}`}
                rows={2}
                value={row.value === null ? '' : String(row.value)}
                placeholder={
                  row.value === null
                    ? 'No description (null)'
                    : 'Enter a description'
                }
                onChange={(e) =>
                  apply(
                    rows.map((r, i) =>
                      i === index ? { ...r, value: e.target.value } : r,
                    ),
                  )
                }
              />
            )}
          </label>
          <button
            type="button"
            aria-label={`Remove criterion ${label} ${index + 1}`}
            onClick={() => apply(rows.filter((_, i) => i !== index))}
          >
            −
          </button>
        </div>
      ))}
      {kind === 'score' && (
        <p className="hint">
          Arrange levels from lowest to highest (2–10 levels).
        </p>
      )}
      {invalid && (
        <p role="alert" className="validation">
          Check empty or duplicate keys and the number of criteria. Saving and
          execution are blocked until these are valid.
        </p>
      )}
    </div>
  );
}
function ContentEditor({
  label,
  value,
  onChange,
}: {
  label: string;
  value: Question['instructions'];
  onChange: (v: Question['instructions']) => void;
}) {
  return typeof value === 'string' ? (
    <label>
      {label}
      <textarea
        aria-label={label}
        rows={2}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  ) : (
    <JsonField
      label={label}
      value={value}
      onChange={(v) => {
        if (typeof v !== 'string' && (!v || typeof v !== 'object'))
          return false;
        onChange(v as Question['instructions']);
        return true;
      }}
    />
  );
}
function JsonField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: unknown;
  onChange: (v: unknown) => boolean;
}) {
  const reportInvalid = useContext(DraftValidity);
  const [draft, setDraft] = useState(pretty(value)),
    [invalid, setInvalid] = useState(false);
  useEffect(() => {
    setDraft(pretty(value));
    setInvalid(false);
  }, [value]);
  useEffect(() => {
    reportInvalid(label, invalid);
    return () => reportInvalid(label, false);
  }, [label, invalid, reportInvalid]);
  return (
    <label>
      {label}
      <textarea
        aria-label={label}
        className="code"
        rows={5}
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value);
          try {
            setInvalid(!onChange(JSON.parse(e.target.value)));
          } catch {
            setInvalid(true);
          }
        }}
      />
      {invalid && (
        <span className="validation">
          Invalid JSON or value type. The last valid value is retained.
        </span>
      )}
    </label>
  );
}
function StateEditor({
  value,
  onChange,
}: {
  value: Query['state'];
  onChange: (v: Query['state']) => void;
}) {
  const structured = typeof value !== 'string';
  return (
    <div>
      <label className="state-label">
        Input / State
        <select
          aria-label="Input format"
          value={structured ? 'json' : 'text'}
          onChange={(e) =>
            onChange(
              e.target.value === 'json' ? { text: value } : pretty(value),
            )
          }
        >
          <option value="text">Text</option>
          <option value="json">JSON</option>
        </select>
      </label>
      {structured ? (
        <JsonField
          label="Input JSON"
          value={value}
          onChange={(v) => {
            if (!v || typeof v !== 'object') return false;
            onChange(v as Query['state']);
            return true;
          }}
        />
      ) : (
        <textarea
          aria-label="Input text"
          rows={5}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
      <p className="hint">
        Enter the information and context needed for the decision.
      </p>
    </div>
  );
}
function LocalWorkspace() {
  const [users, setUsers] = useState<LocalUser[]>([]),
    [userId, setUserId] = useState(''),
    [error, setError] = useState(''),
    [switching, setSwitching] = useState(false),
    [name, setName] = useState('');
  const beforeSwitch = useRef<null | (() => Promise<void>)>(null);
  useEffect(() => {
    api<{ users: LocalUser[]; defaultUserId: string }>('local-users')
      .then((v) => {
        setUsers(v.users);
        const saved = localStorage.getItem('localUserId');
        const chosen =
          v.users.find((u) => u.id === saved && u.kind === 'local')?.id ??
          v.defaultUserId;
        localStorage.setItem('localUserId', chosen);
        setUserId(chosen);
      })
      .catch((e) => setError(e.message));
  }, []);
  async function change(id: string) {
    if (id === userId) return;
    setSwitching(true);
    setError('');
    try {
      await beforeSwitch.current?.();
      beforeSwitch.current = null;
      localStorage.setItem('localUserId', id);
      setUserId(id);
    } catch (e) {
      localStorage.setItem('localUserId', userId);
      setError(e instanceof Error ? e.message : 'Could not switch users.');
    } finally {
      setSwitching(false);
    }
  }
  useEffect(() => {
    const listen = (e: StorageEvent) => {
      if (e.key === 'localUserId' && e.newValue) {
        const target = e.newValue;
        void api<{ users: LocalUser[] }>(
          'local-users',
          undefined,
          'GET',
          userId,
        )
          .then((v) => {
            setUsers(v.users);
            if (v.users.some((u) => u.id === target && u.kind === 'local'))
              return change(target);
          })
          .catch((e) => setError(e.message));
      }
    };
    window.addEventListener('storage', listen);
    return () => window.removeEventListener('storage', listen);
  }, [userId, users]);
  async function add() {
    try {
      const u = await api<LocalUser>('local-users', { name });
      setUsers((prev) => [...prev, u]);
      setName('');
      await change(u.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not add the user.');
    }
  }
  const user = users.find((u) => u.id === userId);
  return (
    <>
      <div className="identity-bar">
        <label>
          Local user{' '}
          <select
            aria-label="Local user"
            value={userId}
            disabled={switching}
            onChange={(e) => void change(e.target.value)}
          >
            {users
              .filter((u) => u.kind === 'local')
              .map((u) => (
                <option key={u.id} value={u.id}>
                  {displayUserName(u)} · {u.id.slice(0, 6)}
                </option>
              ))}
          </select>
        </label>
        <input
          aria-label="New user name"
          placeholder="New user name"
          value={name}
          maxLength={80}
          onChange={(e) => setName(e.target.value)}
        />
        <button disabled={!name.trim() || switching} onClick={() => void add()}>
          Add user
        </button>
        <small>
          For attribution only. No authentication or access control.
        </small>
      </div>
      {error && (
        <div role="alert" className="alert">
          {error}
        </div>
      )}
      {user ? (
        <App
          key={user.id}
          user={user}
          users={users}
          beforeSwitch={beforeSwitch}
        />
      ) : (
        <p>Loading users…</p>
      )}
    </>
  );
}
createRoot(document.getElementById('root')!).render(<LocalWorkspace />);
